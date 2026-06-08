import { Queue, Worker, type Job } from 'bullmq';
import { bullConnection } from './connection';
import { logger } from '../logger';
import { processWebhookEvent } from '../whatsapp/messageProcessor';
import type { WebhookPayload } from '../whatsapp/types';
import { expirePendingReservations } from '../chatbot/orderService';
import { cleanupStaleConversationOrderContexts } from '../chatbot/orderContextGuard';
import { sendDueSupportNudges } from '../chatbot/supportNudge';

export const WEBHOOK_QUEUE_NAME = 'wa-webhook';
export const MAINTENANCE_QUEUE_NAME = 'order-maintenance';

export interface WebhookJobData {
  payload: WebhookPayload;
  receivedAt: string;
}

export interface MaintenanceJobData {
  kind: 'expire_pending_reservations' | 'cleanup_stale_conversation_contexts' | 'send_support_nudges';
}

export const webhookQueue = new Queue<WebhookJobData>(WEBHOOK_QUEUE_NAME, {
  connection: bullConnection,
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: 'exponential', delay: 1000 },
    removeOnComplete: { age: 3600, count: 1000 },
    removeOnFail: { age: 86400 },
  },
});

export const maintenanceQueue = new Queue<MaintenanceJobData>(MAINTENANCE_QUEUE_NAME, {
  connection: bullConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 },
    removeOnComplete: { age: 3600, count: 1000 },
    removeOnFail: { age: 86400 },
  },
});

export function startWebhookWorker(): Worker<WebhookJobData> {
  const worker = new Worker<WebhookJobData>(
    WEBHOOK_QUEUE_NAME,
    async (job: Job<WebhookJobData>) => {
      await processWebhookEvent(job.data.payload);
    },
    { connection: bullConnection, concurrency: 5 },
  );

  worker.on('failed', (job, err) => {
    logger.error(
      { jobId: job?.id, attempts: job?.attemptsMade, err: err.message },
      'webhook job failed',
    );
  });

  worker.on('completed', (job) => {
    logger.debug({ jobId: job.id }, 'webhook job completed');
  });

  worker.on('error', (err) => {
    logger.error({ err: err.message }, 'webhook worker error');
  });

  logger.info({ queue: WEBHOOK_QUEUE_NAME }, 'webhook worker started');
  return worker;
}

export async function scheduleMaintenanceJobs(): Promise<void> {
  await maintenanceQueue.add(
    'expire_pending_reservations',
    { kind: 'expire_pending_reservations' },
    {
      jobId: 'expire_pending_reservations',
      repeat: { every: 60_000 },
    },
  );
  await maintenanceQueue.add(
    'cleanup_stale_conversation_contexts',
    { kind: 'cleanup_stale_conversation_contexts' },
    {
      jobId: 'cleanup_stale_conversation_contexts',
      repeat: { every: 120_000 },
    },
  );
  await maintenanceQueue.add(
    'send_support_nudges',
    { kind: 'send_support_nudges' },
    {
      jobId: 'send_support_nudges',
      repeat: { every: 60_000 },
    },
  );
}

export function startMaintenanceWorker(): Worker<MaintenanceJobData> {
  const worker = new Worker<MaintenanceJobData>(
    MAINTENANCE_QUEUE_NAME,
    async (job: Job<MaintenanceJobData>) => {
      if (job.data.kind === 'expire_pending_reservations') {
        const expired = await expirePendingReservations();
        if (expired > 0) logger.info({ expired }, 'expired unpaid pending reservations');
        return;
      }
      if (job.data.kind === 'cleanup_stale_conversation_contexts') {
        const cleaned = await cleanupStaleConversationOrderContexts();
        if (cleaned.paused > 0 || cleaned.cleared > 0) {
          logger.info(cleaned, 'cleaned stale conversation order contexts');
        }
        return;
      }
      if (job.data.kind === 'send_support_nudges') {
        const sent = await sendDueSupportNudges();
        if (sent > 0) logger.info({ sent }, 'support nudges sent');
      }
    },
    { connection: bullConnection, concurrency: 1 },
  );

  worker.on('failed', (job, err) => {
    logger.error(
      { jobId: job?.id, attempts: job?.attemptsMade, err: err.message },
      'maintenance job failed',
    );
  });

  worker.on('error', (err) => {
    logger.error({ err: err.message }, 'maintenance worker error');
  });

  logger.info({ queue: MAINTENANCE_QUEUE_NAME }, 'maintenance worker started');
  return worker;
}

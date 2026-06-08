import { prisma } from '@kda/db';
import { env, logMetaWarnings } from './config/env';
import { logger } from './logger';
import {
  maintenanceQueue,
  scheduleMaintenanceJobs,
  startMaintenanceWorker,
  startWebhookWorker,
  webhookQueue,
} from './queues/messageQueue';
import { redisConnection } from './queues/connection';

let webhookWorker: ReturnType<typeof startWebhookWorker> | null = null;
let maintenanceWorker: ReturnType<typeof startMaintenanceWorker> | null = null;

async function bootstrap(): Promise<void> {
  logMetaWarnings((msg) => logger.warn(msg));
  if (env.NODE_ENV === 'production') {
    logger.warn('local filesystem uploads are enabled; use persistent disk or object storage for production media');
  }

  await prisma.$queryRaw`SELECT 1`;
  await redisConnection.ping();

  webhookWorker = startWebhookWorker();
  maintenanceWorker = startMaintenanceWorker();
  await scheduleMaintenanceJobs();

  logger.info(
    {
      env: env.NODE_ENV,
      webhookQueue: webhookQueue.name,
      maintenanceQueue: maintenanceQueue.name,
    },
    'worker process started',
  );
}

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'worker shutting down');
  try {
    await webhookWorker?.close();
    await maintenanceWorker?.close();
    await webhookQueue.close();
    await maintenanceQueue.close();
    redisConnection.disconnect();
    await prisma.$disconnect();
  } catch (err) {
    logger.error({ err }, 'worker shutdown error');
  }
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => {
  logger.error({ reason: reason instanceof Error ? reason.stack : reason }, 'worker unhandled promise rejection');
});
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'worker uncaught exception');
  void shutdown('uncaughtException');
});

void bootstrap().catch((err) => {
  logger.fatal({ err }, 'worker startup failed');
  process.exit(1);
});

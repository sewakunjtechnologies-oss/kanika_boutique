import crypto from 'node:crypto';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { prisma, PrintJobStatus } from '@kda/db';
import { requireAuth, requireManagerOrOwner } from '../auth/middleware';
import { env } from '../config/env';
import { logger } from '../logger';
import { emitToDashboard } from '../realtime/io';
import { redisConnection } from '../queues/connection';
import {
  claimNextPrintJob,
  createTestLabelJob,
  markPrintJobFailed,
  markPrintJobPrinted,
  markPrintJobPrinting,
} from '../printing/printJobs';

export const printAgentRouter = Router();

const DeviceSchema = z.object({
  deviceId: z.string().min(1).max(120),
});

const HeartbeatSchema = DeviceSchema.extend({
  printerName: z.string().optional(),
  labelProfile: z.enum(['4x3', '4x4_portrait']).optional(),
  printOrientation: z.enum(['portrait']).optional(),
  printRotation: z.number().int().optional(),
  dryRun: z.boolean().optional(),
});

const FailedSchema = DeviceSchema.extend({
  error: z.string().min(1).max(1000),
});

printAgentRouter.post('/print-agent/heartbeat', requirePrintAgentToken, async (req: Request, res: Response): Promise<void> => {
  const parsed = HeartbeatSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_input' });
    return;
  }

  const heartbeat = {
    ...parsed.data,
    lastHeartbeatAt: new Date().toISOString(),
  };
  await redisConnection.set(printAgentHeartbeatKey(parsed.data.deviceId), JSON.stringify(heartbeat), 'EX', 90);
  emitToDashboard('printer_status_changed', heartbeat);
  res.json({ ok: true });
});

printAgentRouter.get('/print-agent/jobs/next', requirePrintAgentToken, async (req: Request, res: Response): Promise<void> => {
  const deviceId = getDeviceId(req);
  if (!deviceId) {
    res.status(400).json({ error: 'device_id_required' });
    return;
  }

  const job = await claimNextPrintJob(deviceId);
  if (!job) {
    res.json({ job: null });
    return;
  }

  logger.info({ jobId: job.id, type: job.type, deviceId }, 'print job claimed');
  res.json({
    job: {
      id: job.id,
      type: job.type,
      status: job.status,
      payload: job.payload,
      attempts: job.attempts,
      createdAt: job.createdAt,
    },
  });
});

printAgentRouter.post('/print-agent/jobs/:id/printing', requirePrintAgentToken, async (req: Request, res: Response): Promise<void> => {
  const parsed = DeviceSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_input' });
    return;
  }
  const job = await markPrintJobPrinting(req.params.id as string, parsed.data.deviceId);
  if (!job) {
    res.status(409).json({ error: 'invalid_job_state' });
    return;
  }
  res.json({ ok: true });
});

printAgentRouter.post('/print-agent/jobs/:id/printed', requirePrintAgentToken, async (req: Request, res: Response): Promise<void> => {
  const parsed = DeviceSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_input' });
    return;
  }
  const job = await markPrintJobPrinted(req.params.id as string, parsed.data.deviceId);
  if (!job) {
    res.status(409).json({ error: 'invalid_job_state' });
    return;
  }
  emitToDashboard('printer_status_changed', { lastPrintedJobId: job.id, lastSuccessfulPrintAt: new Date().toISOString() });
  res.json({ ok: true });
});

printAgentRouter.post('/print-agent/jobs/:id/failed', requirePrintAgentToken, async (req: Request, res: Response): Promise<void> => {
  const parsed = FailedSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_input' });
    return;
  }
  const job = await markPrintJobFailed(req.params.id as string, parsed.data.deviceId, parsed.data.error);
  if (!job) {
    res.status(409).json({ error: 'invalid_job_state' });
    return;
  }
  emitToDashboard('printer_status_changed', { failedJobId: job.id, lastError: job.lastError });
  res.json({ ok: true });
});

printAgentRouter.post('/printer/test-label', requirePrintAgentToken, async (req: Request, res: Response): Promise<void> => {
  const deviceId = getDeviceId(req) ?? 'print-agent';
  const job = await createTestLabelJob(deviceId);
  res.status(201).json({ job: { id: job.id, status: job.status, type: job.type } });
});

printAgentRouter.post('/printer/test-label-request', requireAuth, requireManagerOrOwner, async (req: Request, res: Response): Promise<void> => {
  const job = await createTestLabelJob(req.auth!.sub);
  emitToDashboard('printer_status_changed', { pendingJobId: job.id, testLabel: true });
  res.status(201).json({ job: { id: job.id, status: job.status, type: job.type } });
});

printAgentRouter.get('/printer/status', requireAuth, async (_req: Request, res: Response): Promise<void> => {
  const [pendingJobs, failedJobs, lastPrintedJob] = await Promise.all([
    prisma.printJob.count({ where: { status: PrintJobStatus.PENDING } }),
    prisma.printJob.count({ where: { status: PrintJobStatus.FAILED } }),
    prisma.printJob.findFirst({
      where: { status: PrintJobStatus.PRINTED },
      orderBy: { printedAt: 'desc' },
      select: { id: true, printedAt: true, claimedBy: true },
    }),
  ]);
  const heartbeatKeys = await redisConnection.keys('print-agent:*');
  const heartbeats = await Promise.all(
    heartbeatKeys.map(async (key) => {
      const value = await redisConnection.get(key);
      return value ? JSON.parse(value) as unknown : null;
    }),
  );

  res.json({
    bridgeOnline: heartbeats.length > 0,
    heartbeats: heartbeats.filter(Boolean),
    pendingJobs,
    failedJobs,
    lastSuccessfulPrint: lastPrintedJob,
  });
});

function requirePrintAgentToken(req: Request, res: Response, next: NextFunction): void {
  if (!env.PRINT_AGENT_TOKEN) {
    res.status(503).json({ error: 'print_agent_not_configured' });
    return;
  }
  const header = req.header('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  if (!safeTokenEquals(token, env.PRINT_AGENT_TOKEN)) {
    logger.warn({ path: req.path }, 'print-agent token rejected');
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
}

function safeTokenEquals(a: string, b: string): boolean {
  if (!a || !b) return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function getDeviceId(req: Request): string | null {
  const headerValue = req.header('x-device-id');
  if (headerValue) return headerValue;
  const parsed = DeviceSchema.safeParse(req.body ?? {});
  return parsed.success ? parsed.data.deviceId : null;
}

function printAgentHeartbeatKey(deviceId: string): string {
  return `print-agent:${deviceId}`;
}

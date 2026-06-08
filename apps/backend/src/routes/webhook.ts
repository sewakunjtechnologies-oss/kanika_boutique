import { Router, type Request, type Response } from 'express';
import { env } from '../config/env';
import { botError, botLog, logger } from '../logger';
import { webhookQueue } from '../queues/messageQueue';
import { SIGNATURE_HEADER, verifyWebhookSignature } from '../whatsapp/signatureVerification';
import type { WebhookPayload } from '../whatsapp/types';

// Augment Express.Request so we can stash the raw body for signature verification.
declare module 'express-serve-static-core' {
  interface Request {
    rawBody?: Buffer;
  }
}

export const webhookRouter = Router();

// Meta verification handshake — echo `hub.challenge` if `hub.verify_token` matches.
const WEBHOOK_PATHS = ['/webhook/whatsapp', '/webhook'];

webhookRouter.get(WEBHOOK_PATHS, (req: Request, res: Response): void => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (
    mode === 'subscribe' &&
    typeof token === 'string' &&
    env.META_WEBHOOK_VERIFY_TOKEN !== '' &&
    token === env.META_WEBHOOK_VERIFY_TOKEN
  ) {
    botLog('WEBHOOK_VERIFY_OK', { mode });
    res.status(200).send(typeof challenge === 'string' ? challenge : '');
    return;
  }
  logger.warn({ mode, providedToken: typeof token === 'string' }, 'WEBHOOK_VERIFY_REJECTED');
  res.sendStatus(403);
});

// Inbound webhook — verify signature, enqueue, return 200 fast.
webhookRouter.post(WEBHOOK_PATHS, async (req: Request, res: Response): Promise<void> => {
  const sig = req.header(SIGNATURE_HEADER);
  const rawBody = req.rawBody;

  if (!rawBody) {
    logger.error('webhook missing raw body — middleware misconfigured');
    res.sendStatus(500);
    return;
  }

  if (!verifyWebhookSignature(rawBody, sig, env.META_APP_SECRET)) {
    logger.warn({ hasSig: Boolean(sig), hasSecret: Boolean(env.META_APP_SECRET) }, 'webhook signature invalid');
    res.sendStatus(401);
    return;
  }

  const payload = req.body as WebhookPayload | undefined;
  if (!payload || typeof payload !== 'object') {
    logger.warn('webhook body not a JSON object');
    res.sendStatus(400);
    return;
  }

  const entries = Array.isArray(payload.entry) ? payload.entry : [];
  botLog('WEBHOOK_RECEIVED', {
    entries: entries.length,
    fields: entries.flatMap((e) => e.changes?.map((c) => c.field) ?? []) ?? [],
    object: payload.object,
  });
  botLog('WEBHOOK_PAYLOAD_DEBUG', { payload }, true);

  // Respond before enqueuing finishes — Meta retries on anything over 5s.
  res.sendStatus(200);

  try {
    await webhookQueue.add('event', { payload, receivedAt: new Date().toISOString() });
    logger.debug({ entries: payload.entry?.length ?? 0 }, 'webhook enqueued');
  } catch (err) {
    botError('ERROR_DETAILS', err, { step: 'webhook_enqueue' });
  }
});

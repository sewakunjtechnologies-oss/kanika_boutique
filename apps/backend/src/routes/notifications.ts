// Dashboard "needs attention" queue — backs the always-on escalation backlog.
//
// Photo escalations (NO_MATCH / CUSTOMER_REJECTED) are persisted as
// DashboardNotification rows by chatbot/escalation.ts. This exposes them so the
// dashboard can render the queue + unread badge and "mark handled" to clear an item.
// Live updates arrive via the 'photo_escalation' socket event; this REST surface is
// the durable backlog + the mark-handled action.

import { Router, type Request, type Response } from 'express';
import { prisma } from '@kda/db';
import { requireAuth } from '../auth/middleware';

export const notificationsRouter = Router();
notificationsRouter.use(requireAuth);

const PHOTO_ESCALATION = 'PHOTO_ESCALATION';

// GET /notifications/escalations?status=unread|all — the photo-escalation queue.
notificationsRouter.get('/notifications/escalations', async (req: Request, res: Response): Promise<void> => {
  const includeHandled = req.query.status === 'all';
  const where = { type: PHOTO_ESCALATION, ...(includeHandled ? {} : { readAt: null }) };
  const [items, unreadCount] = await Promise.all([
    prisma.dashboardNotification.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 100,
    }),
    prisma.dashboardNotification.count({ where: { type: PHOTO_ESCALATION, readAt: null } }),
  ]);
  res.json({ items, unreadCount });
});

// POST /notifications/:id/handled — "mark handled": clears the item from the queue.
notificationsRouter.post('/notifications/:id/handled', async (req: Request, res: Response): Promise<void> => {
  const id = req.params.id as string;
  const result = await prisma.dashboardNotification.updateMany({
    where: { id, type: PHOTO_ESCALATION, readAt: null },
    data: { readAt: new Date() },
  });
  if (result.count === 0) {
    res.status(404).json({ error: 'not_found_or_already_handled' });
    return;
  }
  res.json({ ok: true });
});

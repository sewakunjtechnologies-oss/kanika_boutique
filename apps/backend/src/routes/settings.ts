import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { prisma } from '@kda/db';
import { requireAuth, requireOwner } from '../auth/middleware';

export const settingsRouter = Router();
settingsRouter.use(requireAuth);

settingsRouter.get('/settings', async (_req: Request, res: Response): Promise<void> => {
  const rows = await prisma.setting.findMany();
  const map: Record<string, string> = {};
  for (const r of rows) map[r.key] = r.value;
  res.json({ settings: map });
});

const UpdateSchema = z.object({
  settings: z.record(z.string(), z.string()),
});

settingsRouter.put('/settings', requireOwner, async (req: Request, res: Response): Promise<void> => {
  const parsed = UpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_input' });
    return;
  }
  for (const [key, value] of Object.entries(parsed.data.settings)) {
    await prisma.setting.upsert({
      where: { key },
      create: { key, value },
      update: { value },
    });
  }
  res.json({ ok: true });
});

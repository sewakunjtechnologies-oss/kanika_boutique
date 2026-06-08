import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { Prisma, prisma } from '@kda/db';
import { requireAuth, requireOwner } from '../auth/middleware';

export const categoriesRouter = Router();
categoriesRouter.use(requireAuth);

const CategorySchema = z.object({
  name: z.string().min(1).max(80),
  isActive: z.boolean().optional(),
});

categoriesRouter.get('/categories', async (_req: Request, res: Response): Promise<void> => {
  const categories = await prisma.category.findMany({
    orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
  });
  res.json({ categories });
});

categoriesRouter.post('/categories', requireOwner, async (req: Request, res: Response): Promise<void> => {
  const parsed = CategorySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_input', fields: parsed.error.flatten().fieldErrors });
    return;
  }

  try {
    const category = await prisma.category.create({
      data: {
        name: parsed.data.name.trim(),
        slug: slugify(parsed.data.name),
        isActive: parsed.data.isActive ?? true,
      },
    });
    res.status(201).json({ category });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      res.status(409).json({ error: 'category_exists' });
      return;
    }
    throw err;
  }
});

categoriesRouter.put('/categories/:id', requireOwner, async (req: Request, res: Response): Promise<void> => {
  const parsed = CategorySchema.partial().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_input', fields: parsed.error.flatten().fieldErrors });
    return;
  }

  try {
    const data: Prisma.CategoryUpdateInput = {};
    if (parsed.data.name !== undefined) {
      data.name = parsed.data.name.trim();
      data.slug = slugify(parsed.data.name);
    }
    if (parsed.data.isActive !== undefined) data.isActive = parsed.data.isActive;
    const category = await prisma.category.update({
      where: { id: req.params.id as string },
      data,
    });
    res.json({ category });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      res.status(409).json({ error: 'category_exists' });
      return;
    }
    throw err;
  }
});

function slugify(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || `category-${Date.now().toString(36)}`;
}

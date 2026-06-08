import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { prisma, Prisma } from '@kda/db';
import { requireAuth } from '../auth/middleware';

export const customersRouter = Router();
customersRouter.use(requireAuth);

const UpdateCustomerSchema = z.object({
  name: z.string().min(1).max(120).nullable().optional(),
  email: z.string().email().nullable().optional(),
  defaultAddress: z.string().max(500).nullable().optional(),
  defaultCity: z.string().max(120).nullable().optional(),
  defaultState: z.string().max(120).nullable().optional(),
  defaultPincode: z.string().max(20).nullable().optional(),
});

customersRouter.get('/customers', async (req: Request, res: Response): Promise<void> => {
  const q = (req.query.q as string) ?? '';
  const customers = await prisma.customer.findMany({
    where: q
      ? {
          OR: [
            { name: { contains: q, mode: 'insensitive' } },
            { whatsappNumber: { contains: q } },
          ],
        }
      : {},
    orderBy: { totalSpent: 'desc' },
    take: 200,
  });
  res.json({
    customers: customers.map((c) => ({
      ...c,
      totalSpent: c.totalSpent.toString(),
    })),
  });
});

customersRouter.get('/customers/:id', async (req: Request, res: Response): Promise<void> => {
  const customer = await prisma.customer.findUnique({
    where: { id: req.params.id as string },
    include: {
      orders: {
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          orderNumber: true,
          status: true,
          totalAmount: true,
          createdAt: true,
        },
      },
    },
  });
  if (!customer) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  res.json({
    customer: {
      ...customer,
      totalSpent: customer.totalSpent.toString(),
      orders: customer.orders.map((o) => ({ ...o, totalAmount: o.totalAmount.toString() })),
    },
  });
});

// =============================================================================
// UPDATE
// =============================================================================
customersRouter.put('/customers/:id', async (req: Request, res: Response): Promise<void> => {
  const parsed = UpdateCustomerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_input', fields: parsed.error.flatten().fieldErrors });
    return;
  }
  const updated = await prisma.customer.update({
    where: { id: req.params.id as string },
    data: parsed.data,
  });
  res.json({
    customer: { ...updated, totalSpent: updated.totalSpent.toString() },
  });
});

// =============================================================================
// DELETE — cascades to conversations + messages. Blocked if the customer has
// any orders (Order→Customer is onDelete: Restrict).
// =============================================================================
customersRouter.delete('/customers/:id', async (req: Request, res: Response): Promise<void> => {
  const id = req.params.id as string;
  try {
    await prisma.customer.delete({ where: { id } });
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2003') {
      res.status(409).json({
        error: 'has_orders',
        message: 'Customer has orders. Delete the orders first, or keep the record for history.',
      });
      return;
    }
    throw err;
  }
});

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { prisma, OrderApprovalStatus, OrderStatus, ConversationState, StockMovementType, Prisma } from '@kda/db';
import { logger } from '../logger';
import { requireAuth, requireManagerOrOwner, requireOwner } from '../auth/middleware';
import { emitToDashboard } from '../realtime/io';
import { sendText } from '../whatsapp/client';
import { printSource } from '../printing/printNodeClient';
import { getBusinessSettings } from '../settings/businessSettings';
import { getPaymentReviewWarnings } from '../chatbot/paymentSafety';
import { recordStockMovement } from '../chatbot/orderService';
import { pauseConversationsForOrder, readOrderContext } from '../chatbot/orderContextGuard';
import { env } from '../config/env';
import { createAutomaticOrderLabelJob, createManualOrderLabelJob } from '../printing/printJobs';

export const ordersRouter = Router();
ordersRouter.use(requireAuth);

const APPROVABLE_STATUSES: OrderStatus[] = [OrderStatus.PAYMENT_RECEIVED, OrderStatus.PAYMENT_REVIEW];
const REJECTABLE_STATUSES: OrderStatus[] = [OrderStatus.PAYMENT_RECEIVED, OrderStatus.PAYMENT_REVIEW];
const PRINTABLE_STATUSES: OrderStatus[] = [OrderStatus.VERIFIED, OrderStatus.PRINTED];
const DISPATCHABLE_STATUSES: OrderStatus[] = [OrderStatus.VERIFIED, OrderStatus.PRINTED];
const CANCELLABLE_STATUSES: OrderStatus[] = [
  OrderStatus.PENDING,
  OrderStatus.PAYMENT_RECEIVED,
  OrderStatus.PAYMENT_REVIEW,
];
const ORDER_APPROVABLE_STATUSES: OrderStatus[] = [
  OrderStatus.PENDING,
  OrderStatus.PAYMENT_RECEIVED,
  OrderStatus.PAYMENT_REVIEW,
];

// =============================================================================
// LIST
// =============================================================================

ordersRouter.get('/orders', async (req: Request, res: Response): Promise<void> => {
  const status = req.query.status as OrderStatus | undefined;
  const limit = Math.min(parseInt((req.query.limit as string) ?? '50', 10) || 50, 200);

  const orders = await prisma.order.findMany({
    where: status ? { status } : {},
    include: {
      customer: { select: { whatsappNumber: true, name: true } },
      items: { select: { id: true, quantity: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });

  // Surface orders awaiting payment approval at the top so the owner sees them
  // first (newest-first within each group is preserved by the stable sort).
  const approvalPriority = (s: OrderStatus): number =>
    s === OrderStatus.PAYMENT_REVIEW ? 0 : s === OrderStatus.PAYMENT_RECEIVED ? 1 : 2;
  orders.sort((a, b) => approvalPriority(a.status) - approvalPriority(b.status));

  res.json({
    orders: orders.map((o) => ({
      ...o,
      subtotal: o.subtotal.toString(),
      shippingFee: o.shippingFee.toString(),
      totalAmount: o.totalAmount.toString(),
      paymentExtractedAmount: o.paymentExtractedAmount?.toString() ?? null,
      itemCount: o.items.reduce((s, i) => s + i.quantity, 0),
    })),
  });
});

// =============================================================================
// GET DETAIL
// =============================================================================

ordersRouter.get('/orders/:id', async (req: Request, res: Response): Promise<void> => {
  const order = await prisma.order.findUnique({
    where: { id: (req.params.id as string) },
    include: {
      customer: { select: { id: true, whatsappNumber: true, name: true } },
      items: {
        include: {
          variant: {
            include: { product: { select: { id: true, name: true, sku: true, imageUrl: true } } },
          },
        },
      },
    },
  });
  if (!order) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  res.json({
    order: {
      ...order,
      subtotal: order.subtotal.toString(),
      shippingFee: order.shippingFee.toString(),
      totalAmount: order.totalAmount.toString(),
      paymentExtractedAmount: order.paymentExtractedAmount?.toString() ?? null,
      items: order.items.map((i) => ({
        ...i,
        unitPrice: i.unitPrice.toString(),
        variant: {
          ...i.variant,
          priceOverride: i.variant.priceOverride?.toString() ?? null,
        },
      })),
    },
  });
});

// =============================================================================
// OWNER ORDER APPROVAL — separate from payment approval.
// =============================================================================

const RejectOrderSchema = z.object({ reason: z.string().max(500).optional() });
const DeliveryChargeSchema = z.object({ shippingFee: z.number().nonnegative() });

ordersRouter.post(
  '/orders/:id/delivery-charge',
  requireOwner,
  async (req: Request, res: Response): Promise<void> => {
    const parsed = DeliveryChargeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_input' });
      return;
    }
    const order = await prisma.order.findUnique({
      where: { id: req.params.id as string },
      select: { id: true, status: true, subtotal: true, approvalStatus: true },
    });
    if (!order) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    if (order.approvalStatus !== OrderApprovalStatus.PENDING_OWNER_APPROVAL || !ORDER_APPROVABLE_STATUSES.includes(order.status)) {
      res.status(409).json({ error: 'invalid_status_transition', action: 'update_delivery_charge', status: order.status });
      return;
    }
    const shippingFee = new Prisma.Decimal(parsed.data.shippingFee);
    const totalAmount = order.subtotal.plus(shippingFee);
    const updated = await prisma.order.update({
      where: { id: order.id },
      data: { shippingFee, totalAmount },
    });
    emitToDashboard('order_status_changed', { orderId: order.id, deliveryChargeUpdated: true });
    res.json({
      order: {
        id: updated.id,
        shippingFee: updated.shippingFee.toString(),
        totalAmount: updated.totalAmount.toString(),
      },
    });
  },
);

ordersRouter.post(
  '/orders/:id/approve-order',
  requireOwner,
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.auth!.sub;
    try {
      const updated = await prisma.$transaction(async (tx) => {
        const order = await tx.order.findUnique({
          where: { id: req.params.id as string },
          include: {
            items: { select: { productVariantId: true, quantity: true } },
            customer: { select: { whatsappNumber: true } },
          },
        });
        if (!order) throw new RouteError(404, 'not_found');
        if (order.approvalStatus === OrderApprovalStatus.APPROVED) {
          throw new RouteError(409, 'order_already_approved');
        }
        if (!ORDER_APPROVABLE_STATUSES.includes(order.status)) {
          throw new RouteError(409, 'invalid_status_transition', {
            action: 'approve_order',
            status: order.status,
          });
        }

        const claim = await tx.order.updateMany({
          where: {
            id: order.id,
            approvalStatus: OrderApprovalStatus.PENDING_OWNER_APPROVAL,
            status: { in: ORDER_APPROVABLE_STATUSES },
          },
          data: {
            status: OrderStatus.VERIFIED,
            approvalStatus: OrderApprovalStatus.APPROVED,
            approvedById: userId,
            approvedAt: new Date(),
            rejectedById: null,
            rejectedAt: null,
            rejectionReason: null,
          },
        });
        if (claim.count !== 1) {
          throw new RouteError(409, 'order_already_processed');
        }

        await deductStockForOrder(tx, order, userId, `Stock deducted for owner-approved order ${order.orderNumber}`);
        await tx.customer.update({
          where: { id: order.customerId },
          data: {
            totalOrders: { increment: 1 },
            totalSpent: { increment: order.totalAmount },
          },
        });
        return tx.order.findUniqueOrThrow({
          where: { id: order.id },
          include: { customer: { select: { whatsappNumber: true } } },
        });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

      emitToDashboard('order_status_changed', {
        orderId: updated.id,
        status: updated.status,
        approvalStatus: updated.approvalStatus,
      });

      try {
        await sendText(
          updated.customer.whatsappNumber,
          `Your order #${updated.orderNumber} has been approved by Kanika Designs. We will share the next update soon.`,
        );
      } catch (err) {
        logger.warn({ err, orderId: updated.id }, 'failed to send order approval WhatsApp');
      }

      res.json({ order: { id: updated.id, status: updated.status, approvalStatus: updated.approvalStatus } });
    } catch (err) {
      handleOrderRouteError(err, res, 'approve_order_failed');
    }
  },
);

ordersRouter.post(
  '/orders/:id/reject-order',
  requireOwner,
  async (req: Request, res: Response): Promise<void> => {
    const parsed = RejectOrderSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_input' });
      return;
    }
    const userId = req.auth!.sub;
    const order = await prisma.order.findUnique({
      where: { id: req.params.id as string },
      include: { customer: { select: { id: true, whatsappNumber: true } } },
    });
    if (!order) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    if (order.approvalStatus === OrderApprovalStatus.APPROVED || !ORDER_APPROVABLE_STATUSES.includes(order.status)) {
      res.status(409).json({ error: 'invalid_status_transition', action: 'reject_order', status: order.status });
      return;
    }

    const updated = await prisma.order.update({
      where: { id: order.id },
      data: {
        status: OrderStatus.REJECTED,
        approvalStatus: OrderApprovalStatus.REJECTED,
        rejectedById: userId,
        rejectedAt: new Date(),
        rejectionReason: parsed.data.reason ?? null,
      },
    });
    await pauseConversationsForOrder(order.customerId, order.id, 'order_closed');
    emitToDashboard('order_status_changed', {
      orderId: order.id,
      status: updated.status,
      approvalStatus: updated.approvalStatus,
    });

    try {
      await sendText(
        order.customer.whatsappNumber,
        parsed.data.reason
          ? `Sorry, your order #${order.orderNumber} was not approved. Reason: ${parsed.data.reason}`
          : `Sorry, your order #${order.orderNumber} was not approved. Please contact the boutique team for help.`,
      );
    } catch (err) {
      logger.warn({ err, orderId: order.id }, 'failed to send order rejection WhatsApp');
    }

    res.json({ ok: true });
  },
);

// =============================================================================
// VERIFY PAYMENT (approve) — deducts stock, sends confirmation, triggers print
// =============================================================================

const ApprovePaymentSchema = z.object({
  overridePaymentWarnings: z.boolean().optional(),
});

ordersRouter.post(
  ['/orders/:id/verify-payment', '/orders/:id/approve-payment'],
  requireOwner,
  async (req: Request, res: Response): Promise<void> => {
    const parsed = ApprovePaymentSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_input' });
      return;
    }
    const userId = req.auth!.sub;
    const order = await prisma.order.findUnique({
      where: { id: (req.params.id as string) },
      include: {
        items: { select: { id: true, productVariantId: true, quantity: true } },
        customer: { select: { id: true, whatsappNumber: true } },
      },
    });
    if (!order) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    if (!APPROVABLE_STATUSES.includes(order.status)) {
      res.status(409).json({ error: 'invalid_status_transition', action: 'approve_payment', status: order.status });
      return;
    }

    const settings = await getBusinessSettings();
    const paymentWarnings = await getPaymentReviewWarnings({
      orderId: order.id,
      expectedAmount: Number(order.totalAmount.toString()),
      expectedReceiverUpi: settings.upiId,
      extractedAmount: order.paymentExtractedAmount ? Number(order.paymentExtractedAmount.toString()) : null,
      extractedReceiver: order.paymentExtractedReceiver,
      extractedUtr: order.paymentExtractedUtr,
      looksLegitimate: order.paymentLooksLegitimate,
    });
    if (paymentWarnings.length > 0 && !parsed.data.overridePaymentWarnings) {
      res.status(409).json({ error: 'payment_review_required', warnings: paymentWarnings });
      return;
    }

    try {
      let automaticPrintJobId: string | null = null;
      const updated = await prisma.$transaction(async (tx) => {
        const freshOrder = await tx.order.findUnique({
          where: { id: order.id },
          include: {
            items: { select: { id: true, productVariantId: true, quantity: true } },
            customer: { select: { id: true, whatsappNumber: true } },
          },
        });
        if (!freshOrder) throw new RouteError(404, 'not_found');
        const claim = await tx.order.updateMany({
          where: {
            id: freshOrder.id,
            status: { in: APPROVABLE_STATUSES },
            approvalStatus: OrderApprovalStatus.PENDING_OWNER_APPROVAL,
          },
          data: {
            status: OrderStatus.VERIFIED,
            approvalStatus: OrderApprovalStatus.APPROVED,
            approvedById: userId,
            approvedAt: new Date(),
            paymentVerifiedAt: new Date(),
            paymentVerifiedBy: userId,
            rejectedById: null,
            rejectedAt: null,
            rejectionReason: null,
          },
        });
        if (claim.count !== 1) {
          throw new RouteError(409, 'order_already_processed');
        }

        await deductStockForOrder(tx, freshOrder, userId, `Stock deducted for approved payment ${freshOrder.orderNumber}`);
        // Bump customer totals.
        await tx.customer.update({
          where: { id: freshOrder.customerId },
          data: {
            totalOrders: { increment: 1 },
            totalSpent: { increment: freshOrder.totalAmount },
          },
        });
        if (env.AUTO_PRINT_ORDER_LABELS) {
          const job = await createAutomaticOrderLabelJob(tx, freshOrder.id);
          automaticPrintJobId = job?.id ?? null;
        }
        return tx.order.findUniqueOrThrow({ where: { id: freshOrder.id } });
      });

      // Move conversation forward.
      const conv = await prisma.conversation.findFirst({
        where: { customerId: order.customerId },
        orderBy: { lastInboundAt: 'desc' },
      });
      if (conv) {
        await prisma.conversation.update({
          where: { id: conv.id },
          data: { state: ConversationState.COMPLETED, contextJson: {} },
        });
      }

      emitToDashboard('order_status_changed', { orderId: order.id, status: 'VERIFIED' });

      // Notify customer.
      try {
        await sendText(order.customer.whatsappNumber, 'Payment approved. Your order is confirmed.');
      } catch (err) {
        logger.warn({ err, orderId: order.id }, 'failed to send confirmation WhatsApp');
      }

      if (automaticPrintJobId) {
        emitToDashboard('printer_status_changed', { pendingJobId: automaticPrintJobId, orderId: order.id });
      }

      res.json({ order: { id: updated.id, status: updated.status }, printJobId: automaticPrintJobId });
    } catch (err) {
      logger.error({ err }, 'verify-payment failed');
      if (err instanceof RouteError) {
        res.status(err.status).json({ error: err.code, ...(err.details ?? {}) });
        return;
      }
      if (err instanceof Error && err.message.startsWith('insufficient_stock:')) {
        res.status(409).json({ error: 'insufficient_stock' });
        return;
      }
      res.status(500).json({ error: 'verify_failed' });
    }
  },
);

// =============================================================================
// REJECT PAYMENT — sends rejection, resets conversation to AWAITING_PAYMENT_SCREENSHOT
// =============================================================================

const RejectSchema = z.object({ reason: z.string().optional() });

ordersRouter.post(
  '/orders/:id/reject-payment',
  requireOwner,
  async (req: Request, res: Response): Promise<void> => {
    const parsed = RejectSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_input' });
      return;
    }
    const userId = req.auth!.sub;
    const existing = await prisma.order.findUnique({
      where: { id: (req.params.id as string) },
      select: { id: true, status: true },
    });
    if (!existing) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    if (!REJECTABLE_STATUSES.includes(existing.status)) {
      res.status(409).json({ error: 'invalid_status_transition', action: 'reject_payment', status: existing.status });
      return;
    }

    const order = await prisma.order.update({
      where: { id: existing.id },
      data: {
        status: OrderStatus.REJECTED,
        rejectedById: userId,
        rejectedAt: new Date(),
        rejectionReason: parsed.data.reason ?? null,
      },
      include: { customer: { select: { id: true, whatsappNumber: true } } },
    });

    const conv = await prisma.conversation.findFirst({
      where: { customerId: order.customerId },
      orderBy: { lastInboundAt: 'desc' },
    });
    if (conv) {
      const ctx = readOrderContext(conv.contextJson);
      await prisma.conversation.update({
        where: { id: conv.id },
        data: {
          state: ConversationState.AWAITING_PAYMENT_SCREENSHOT,
          contextJson: {
            ...ctx,
            orderId: order.id,
            orderNumber: order.orderNumber,
            total: Number(order.totalAmount.toString()),
          } as never,
          humanTakeover: false,
          humanTakeoverUntil: null,
        },
      });
    }

    emitToDashboard('order_status_changed', { orderId: order.id, status: 'REJECTED' });

    try {
      await sendText(
        order.customer.whatsappNumber,
        'Payment could not be approved. Please send a clear payment screenshot again.',
      );
    } catch (err) {
      logger.warn({ err, orderId: order.id }, 'failed to send rejection WhatsApp');
    }

    res.json({ ok: true });
  },
);

// =============================================================================
// MARK DISPATCHED (manual)
// =============================================================================

ordersRouter.post(
  '/orders/:id/mark-dispatched',
  async (req: Request, res: Response): Promise<void> => {
    const existing = await prisma.order.findUnique({
      where: { id: (req.params.id as string) },
      select: { id: true, status: true },
    });
    if (!existing) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    if (!DISPATCHABLE_STATUSES.includes(existing.status)) {
      res.status(409).json({ error: 'invalid_status_transition', action: 'dispatch', status: existing.status });
      return;
    }
    const order = await prisma.order.update({
      where: { id: existing.id },
      data: { status: OrderStatus.DISPATCHED },
    });
    emitToDashboard('order_status_changed', { orderId: order.id, status: 'DISPATCHED' });
    res.json({ ok: true });
  },
);

// =============================================================================
// DELETE — only allowed for PENDING / CANCELLED / REJECTED / EXPIRED. Approved orders
// stay for history (revenue + customer totals were already accounted for).
// `?hard=true` deletes; otherwise marks CANCELLED.
// =============================================================================

const HARD_DELETABLE_STATUSES: OrderStatus[] = [
  OrderStatus.PENDING,
  OrderStatus.CANCELLED,
  OrderStatus.REJECTED,
  OrderStatus.EXPIRED,
];

ordersRouter.delete('/orders/:id', async (req: Request, res: Response): Promise<void> => {
  const id = req.params.id as string;
  const hard = req.query.hard === 'true';

  const order = await prisma.order.findUnique({
    where: { id },
    select: { id: true, customerId: true, status: true },
  });
  if (!order) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  if (hard && !HARD_DELETABLE_STATUSES.includes(order.status)) {
    res.status(409).json({
      error: 'order_already_processed',
      message: `Cannot permanently delete an order in status ${order.status}.`,
    });
    return;
  }

  if (hard) {
    await prisma.order.delete({ where: { id } });
    await pauseConversationsForOrder(order.customerId, id, 'order_closed');
    emitToDashboard('order_status_changed', { orderId: id, status: 'DELETED' });
    res.json({ ok: true, mode: 'hard' });
    return;
  }

  if (!CANCELLABLE_STATUSES.includes(order.status)) {
    res.status(409).json({ error: 'invalid_status_transition', action: 'cancel', status: order.status });
    return;
  }

  await prisma.order.update({
    where: { id },
    data: { status: OrderStatus.CANCELLED },
  });
  await pauseConversationsForOrder(order.customerId, id, 'order_closed');
  emitToDashboard('order_status_changed', { orderId: id, status: 'CANCELLED' });
  res.json({ ok: true, mode: 'cancelled' });
});

// =============================================================================
// REPRINT
// =============================================================================

ordersRouter.post('/orders/:id/print', requireManagerOrOwner, async (req: Request, res: Response): Promise<void> => {
  try {
    const order = await prisma.order.findUnique({
      where: { id: (req.params.id as string) },
      select: { id: true, status: true },
    });
    if (!order) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    if (!PRINTABLE_STATUSES.includes(order.status)) {
      res.status(409).json({ error: 'invalid_status_transition', action: 'print', status: order.status });
      return;
    }

    const printResult = await printSource({ sourceType: 'WHATSAPP_ORDER', sourceId: order.id });
    await prisma.order.update({
      where: { id: order.id },
      data: { status: OrderStatus.PRINTED, printedAt: new Date() },
    });
    res.json(printResult);
  } catch (err) {
    logger.error({ err }, 'manual print failed');
    res.status(500).json({ error: 'print_failed' });
  }
});

/**
 * Pre-flight validation for the sticker print endpoint. Pure + exported so the
 * branch logic is unit-testable without an HTTP harness. Returns the error
 * response to send, or null when the request may proceed to enqueue a job.
 */
export function stickerPrintValidationError(
  order: { status: OrderStatus; shippingAddress: string } | null,
): { status: number; body: Record<string, unknown> } | null {
  if (!order) return { status: 404, body: { error: 'not_found' } };
  if (!PRINTABLE_STATUSES.includes(order.status)) {
    return { status: 409, body: { error: 'invalid_status_transition', action: 'print_sticker', status: order.status } };
  }
  if (!order.shippingAddress.trim()) return { status: 409, body: { error: 'missing_address' } };
  return null;
}

/**
 * Shapes a failed sticker print into a descriptive JSON body so the dashboard
 * toast can say WHY instead of an opaque "print_failed". [errorId] correlates
 * the toast to the server log line.
 */
export function describeStickerPrintFailure(err: unknown, errorId: string): {
  error: 'print_failed';
  reason: string;
  errorId: string;
} {
  return {
    error: 'print_failed',
    reason: err instanceof Error ? err.message : 'unknown error',
    errorId,
  };
}

ordersRouter.post('/orders/:id/print-sticker', requireManagerOrOwner, async (req: Request, res: Response): Promise<void> => {
  const errorId = `sticker_${Date.now().toString(36)}`;
  try {
    const order = await prisma.order.findUnique({
      where: { id: (req.params.id as string) },
      select: { id: true, status: true, shippingAddress: true },
    });
    const validationError = stickerPrintValidationError(order);
    if (validationError) {
      res.status(validationError.status).json(validationError.body);
      return;
    }

    // Enqueue an ORDER_LABEL PrintJob for the Android bridge to claim + print —
    // the same proven path as /reprint-label, manual receipts and test labels.
    // The order is marked PRINTED by the bridge on real completion
    // (markPrintJobPrinted), NOT optimistically here, so a job that fails or is
    // never claimed can never leave the order in a falsely-printed state.
    const job = await createManualOrderLabelJob(order!.id, req.auth!.sub);
    emitToDashboard('printer_status_changed', { pendingJobId: job.id, orderId: order!.id });
    res.status(200).json({
      ok: true,
      mode: 'manual',
      pdfUrl: '',
      printJobId: job.id,
      status: job.status,
      type: job.type,
      message: 'Sticker print job sent to the label printer.',
    });
  } catch (err) {
    logger.error({ err, orderId: req.params.id, errorId }, 'sticker print failed');
    res.status(500).json(describeStickerPrintFailure(err, errorId));
  }
});

ordersRouter.post('/orders/:id/reprint-label', requireManagerOrOwner, async (req: Request, res: Response): Promise<void> => {
  try {
    const order = await prisma.order.findUnique({
      where: { id: (req.params.id as string) },
      select: { id: true, status: true },
    });
    if (!order) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    if (!PRINTABLE_STATUSES.includes(order.status)) {
      res.status(409).json({ error: 'invalid_status_transition', action: 'reprint_label', status: order.status });
      return;
    }

    const job = await createManualOrderLabelJob(order.id, req.auth!.sub);
    emitToDashboard('printer_status_changed', { pendingJobId: job.id, orderId: order.id });
    res.status(201).json({ job: { id: job.id, status: job.status, type: job.type } });
  } catch (err) {
    logger.error({ err }, 'label reprint job failed');
    res.status(500).json({ error: 'print_failed' });
  }
});

// =============================================================================
// SUMMARY (for dashboard home)
// =============================================================================

ordersRouter.get('/orders-summary/kpis', async (_req: Request, res: Response): Promise<void> => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);

  const [todayCount, pendingVerification, monthRevenue, lowStockVariants] = await Promise.all([
    prisma.order.count({ where: { createdAt: { gte: today } } }),
    prisma.order.count({ where: { status: { in: [OrderStatus.PAYMENT_RECEIVED, OrderStatus.PAYMENT_REVIEW] } } }),
    prisma.order.aggregate({
      _sum: { totalAmount: true },
      where: {
        status: { in: [OrderStatus.VERIFIED, OrderStatus.PRINTED, OrderStatus.DISPATCHED] },
        createdAt: { gte: monthStart },
      },
    }),
    prisma.productVariant.count({ where: { stock: { lt: 3 } } }),
  ]);

  res.json({
    todayOrders: todayCount,
    pendingVerification,
    monthRevenue: monthRevenue._sum.totalAmount?.toString() ?? '0',
    lowStockVariants,
  });
});

interface OrderForStockDeduction {
  id: string;
  orderNumber: string;
  items: { productVariantId: string; quantity: number }[];
}

async function deductStockForOrder(
  tx: Prisma.TransactionClient,
  order: OrderForStockDeduction,
  adminUserId: string,
  note: string,
): Promise<void> {
  for (const item of order.items) {
    const stockUpdate = await tx.productVariant.updateMany({
      where: { id: item.productVariantId, stock: { gte: item.quantity } },
      data: { stock: { decrement: item.quantity } },
    });
    if (stockUpdate.count !== 1) {
      throw new RouteError(409, 'insufficient_stock', { productVariantId: item.productVariantId });
    }
    const updatedVariant = await tx.productVariant.findUnique({
      where: { id: item.productVariantId },
      select: { stock: true },
    });
    if (!updatedVariant) throw new RouteError(409, 'missing_variant', { productVariantId: item.productVariantId });
    await recordStockMovement(
      {
        productVariantId: item.productVariantId,
        type: StockMovementType.ORDER_DEDUCTION,
        quantityChange: -item.quantity,
        previousStock: updatedVariant.stock + item.quantity,
        newStock: updatedVariant.stock,
        orderId: order.id,
        adminUserId,
        note,
      },
      tx,
    );
  }
}

class RouteError extends Error {
  constructor(
    public status: number,
    public code: string,
    public details?: Record<string, unknown>,
  ) {
    super(code);
  }
}

function handleOrderRouteError(err: unknown, res: Response, fallbackCode: string): void {
  logger.error({ err }, fallbackCode);
  if (err instanceof RouteError) {
    res.status(err.status).json({ error: err.code, ...(err.details ?? {}) });
    return;
  }
  res.status(500).json({ error: fallbackCode });
}

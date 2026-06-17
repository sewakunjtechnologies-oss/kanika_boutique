import { prisma, OrderStatus, Prisma, type StockMovement, type StockMovementType } from '@kda/db';
import { calculateDeliveryCharge } from '@kda/shared';
import { env } from '../config/env';
import type { OrderContext } from './stateMachine';

/**
 * Generate the next ORD-YYYY-NNNN order number with a per-year sequence.
 */
async function nextOrderNumber(tx: Prisma.TransactionClient = prisma): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = `ORD-${year}-`;
  const last = await tx.order.findFirst({
    where: { orderNumber: { startsWith: prefix } },
    orderBy: { orderNumber: 'desc' },
    select: { orderNumber: true },
  });
  let seq = 1;
  if (last) {
    const m = last.orderNumber.match(/-(\d+)$/);
    if (m && m[1]) seq = parseInt(m[1], 10) + 1;
  }
  return `${prefix}${seq.toString().padStart(4, '0')}`;
}

export interface CreateOrderFromContextInput {
  customerId: string;
  ctx: OrderContext;
}

export async function createOrderFromContext(
  input: CreateOrderFromContextInput,
): Promise<{ orderId: string; orderNumber: string; total: number } | null> {
  const { ctx, customerId } = input;
  const { productId, size, qty, customerName, address, pincode } = ctx;
  if (!productId || !size || !qty || !customerName || !address || !pincode) {
    return null;
  }
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await prisma.$transaction(async (tx) => {
        // Find the variant for the product + size (color ignored for v1).
        const variant = await tx.productVariant.findFirst({
          where: { productId, size },
          include: { product: { select: { basePrice: true, name: true } } },
        });
        if (!variant) return null;

        const reserved = await activeReservedQuantity(variant.id, tx);
        const availableStock = Math.max(variant.stock - reserved, 0);
        if (availableStock < qty) return null;

        const unitPriceDecimal = variant.priceOverride ?? variant.product.basePrice;
        const unitPrice = Number(unitPriceDecimal.toString());
        const subtotal = unitPrice * qty;
        const shippingFee = calculateDeliveryCharge(qty);
        const total = subtotal + shippingFee;
        const reservationExpiresAt = reservationExpiryFromNow();

        const orderNumber = await nextOrderNumber(tx);

        const order = await tx.order.create({
          data: {
            orderNumber,
            customerId,
            status: OrderStatus.PENDING,
            subtotal: new Prisma.Decimal(subtotal),
            shippingFee: new Prisma.Decimal(shippingFee),
            totalAmount: new Prisma.Decimal(total),
            shippingName: customerName,
            shippingAddress: address,
            shippingCity: ctx.city ?? '',
            shippingState: ctx.state ?? '',
            shippingPincode: pincode,
            reservationExpiresAt,
            items: {
              create: [
                {
                  productVariantId: variant.id,
                  quantity: qty,
                  unitPrice: new Prisma.Decimal(unitPrice),
                },
              ],
            },
          },
          select: { id: true, orderNumber: true },
        });

        await tx.customer.update({
          where: { id: customerId },
          data: {
            name: customerName,
            defaultAddress: address,
            defaultCity: ctx.city ?? '',
            defaultState: ctx.state ?? '',
            defaultPincode: pincode,
          },
        });

        return { orderId: order.id, orderNumber: order.orderNumber, total };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (err) {
      if (isUniqueConstraintError(err) && attempt < 3) continue;
      if (isSerializableWriteConflict(err) && attempt < 3) continue;
      throw err;
    }
  }

  return null;
}

/**
 * Suggest 3 alternative products in the same category, similar price.
 */
export async function suggestAlternatives(
  productId: string,
): Promise<{ id: string; sku: string; name: string; basePrice: string }[]> {
  const base = await prisma.product.findUnique({
    where: { id: productId },
    select: { category: true, basePrice: true },
  });
  if (!base) return [];

  const basePrice = Number(base.basePrice.toString());
  const candidates = await prisma.product.findMany({
    where: {
      id: { not: productId },
      isActive: true,
      category: base.category,
      variants: { some: { isActive: true, stock: { gt: 0 } } },
    },
    select: { id: true, sku: true, name: true, basePrice: true },
    take: 20,
  });
  return candidates
    .map((c) => ({
      ...c,
      distance: Math.abs(Number(c.basePrice.toString()) - basePrice),
      basePrice: c.basePrice.toString(),
    }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 3)
    .map(({ distance: _d, ...rest }) => rest);
}

export async function checkStock(
  productId: string,
  size: string,
  qty: number,
): Promise<{ available: boolean; stock: number; physicalStock: number; reserved: number; variantId: string | null }> {
  const variant = await prisma.productVariant.findFirst({
    where: { productId, size, isActive: true },
    select: { id: true, stock: true },
  });
  if (!variant) return { available: false, stock: 0, physicalStock: 0, reserved: 0, variantId: null };
  const reserved = await activeReservedQuantity(variant.id);
  const stock = Math.max(variant.stock - reserved, 0);
  return { available: stock >= qty, stock, physicalStock: variant.stock, reserved, variantId: variant.id };
}

export async function getProductAvailability(
  productId: string,
): Promise<{
  id: string;
  sku: string;
  name: string;
  category: string;
  basePrice: string;
  isActive: boolean;
  variants: { id: string; size: string; color: string | null; stock: number; physicalStock: number; reserved: number }[];
} | null> {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    include: { variants: { where: { isActive: true }, orderBy: { size: 'asc' } } },
  });
  if (!product) return null;

  const reservations = await prisma.orderItem.groupBy({
    by: ['productVariantId'],
    where: {
      productVariantId: { in: product.variants.map((v) => v.id) },
      order: activeReservationOrderWhere(),
    },
    _sum: { quantity: true },
  });
  const reservedByVariant = new Map(
    reservations.map((r) => [r.productVariantId, r._sum.quantity ?? 0]),
  );

  return {
    id: product.id,
    sku: product.sku,
    name: product.name,
    category: product.category,
    basePrice: product.basePrice.toString(),
    isActive: product.isActive,
    variants: product.variants.map((variant) => {
      const reserved = reservedByVariant.get(variant.id) ?? 0;
      return {
        id: variant.id,
        size: variant.size,
        color: variant.color,
        stock: Math.max(variant.stock - reserved, 0),
        physicalStock: variant.stock,
        reserved,
      };
    }),
  };
}

async function activeReservedQuantity(
  productVariantId: string,
  tx: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<number> {
  const result = await tx.orderItem.aggregate({
    where: {
      productVariantId,
      order: activeReservationOrderWhere(),
    },
    _sum: { quantity: true },
  });
  return result._sum.quantity ?? 0;
}

export function reservationExpiryFromNow(now: Date = new Date()): Date {
  return new Date(now.getTime() + env.ORDER_RESERVATION_MINUTES * 60 * 1000);
}

export function isReservationActiveForStock(
  status: OrderStatus,
  reservationExpiresAt: Date | null,
  now: Date = new Date(),
): boolean {
  if (status === OrderStatus.PAYMENT_RECEIVED || status === OrderStatus.PAYMENT_REVIEW) return true;
  if (status !== OrderStatus.PENDING) return false;
  return reservationExpiresAt === null || reservationExpiresAt > now;
}

function activeReservationOrderWhere(now: Date = new Date()): Prisma.OrderWhereInput {
  return {
    OR: [
      { status: OrderStatus.PAYMENT_RECEIVED },
      { status: OrderStatus.PAYMENT_REVIEW },
      {
        status: OrderStatus.PENDING,
        OR: [{ reservationExpiresAt: null }, { reservationExpiresAt: { gt: now } }],
      },
    ],
  };
}

export async function expirePendingReservations(now: Date = new Date()): Promise<number> {
  const result = await prisma.order.updateMany({
    where: {
      status: OrderStatus.PENDING,
      reservationExpiresAt: { lte: now },
    },
    data: {
      status: OrderStatus.EXPIRED,
      notes: 'Reservation expired before payment was received.',
    },
  });
  return result.count;
}

export interface RecordStockMovementInput {
  productVariantId: string;
  type: StockMovementType;
  quantityChange: number;
  previousStock: number;
  newStock: number;
  orderId?: string | null;
  manualReceiptId?: string | null;
  manualReceiptReturnId?: string | null;
  adminUserId?: string | null;
  note?: string | null;
}

export async function recordStockMovement(
  input: RecordStockMovementInput,
  tx: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<StockMovement> {
  return tx.stockMovement.create({
    data: {
      productVariantId: input.productVariantId,
      type: input.type,
      quantityChange: input.quantityChange,
      previousStock: input.previousStock,
      newStock: input.newStock,
      orderId: input.orderId ?? null,
      manualReceiptId: input.manualReceiptId ?? null,
      manualReceiptReturnId: input.manualReceiptReturnId ?? null,
      adminUserId: input.adminUserId ?? null,
      note: input.note ?? null,
    },
  });
}

export async function getStockMovementsForVariant(
  productVariantId: string,
  limit = 100,
): Promise<StockMovement[]> {
  return prisma.stockMovement.findMany({
    where: { productVariantId },
    orderBy: { createdAt: 'desc' },
    take: Math.min(Math.max(limit, 1), 200),
  });
}

function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

function isSerializableWriteConflict(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2034';
}

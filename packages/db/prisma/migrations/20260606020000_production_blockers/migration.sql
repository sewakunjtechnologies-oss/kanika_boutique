-- Add review/expiry lifecycle states.
ALTER TYPE "OrderStatus" ADD VALUE 'PAYMENT_REVIEW';
ALTER TYPE "OrderStatus" ADD VALUE 'EXPIRED';

-- Track unpaid reservation expiry.
ALTER TABLE "Order" ADD COLUMN "reservationExpiresAt" TIMESTAMP(3);
CREATE INDEX "Order_reservationExpiresAt_idx" ON "Order"("reservationExpiresAt");

-- Stock movement audit trail.
CREATE TYPE "StockMovementType" AS ENUM (
    'MANUAL_ADJUSTMENT',
    'ORDER_DEDUCTION',
    'ORDER_CANCELLATION_RELEASE',
    'CORRECTION'
);

CREATE TABLE "StockMovement" (
    "id" TEXT NOT NULL,
    "productVariantId" TEXT NOT NULL,
    "type" "StockMovementType" NOT NULL,
    "quantityChange" INTEGER NOT NULL,
    "previousStock" INTEGER NOT NULL,
    "newStock" INTEGER NOT NULL,
    "orderId" TEXT,
    "adminUserId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockMovement_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "StockMovement_productVariantId_idx" ON "StockMovement"("productVariantId");
CREATE INDEX "StockMovement_orderId_idx" ON "StockMovement"("orderId");
CREATE INDEX "StockMovement_adminUserId_idx" ON "StockMovement"("adminUserId");
CREATE INDEX "StockMovement_type_idx" ON "StockMovement"("type");
CREATE INDEX "StockMovement_createdAt_idx" ON "StockMovement"("createdAt");

ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_productVariantId_fkey"
FOREIGN KEY ("productVariantId") REFERENCES "ProductVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_orderId_fkey"
FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_adminUserId_fkey"
FOREIGN KEY ("adminUserId") REFERENCES "AdminUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

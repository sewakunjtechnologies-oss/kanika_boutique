-- Manual receipt reprints + returns/reversals.
-- Original receipts remain immutable; returns are represented as separate linked records.

CREATE TYPE "ManualReceiptStatus" AS ENUM ('ACTIVE', 'PARTIALLY_RETURNED', 'RETURNED', 'VOIDED');
CREATE TYPE "ReceiptReturnStatus" AS ENUM ('PENDING', 'COMPLETED', 'CANCELLED');
CREATE TYPE "RefundMethod" AS ENUM ('CASH', 'BANK_TRANSFER', 'UPI', 'STORE_CREDIT', 'NO_REFUND');

ALTER TYPE "StockMovementType" ADD VALUE IF NOT EXISTS 'MANUAL_RECEIPT_RETURN';
ALTER TYPE "PrintJobType" ADD VALUE IF NOT EXISTS 'OFFLINE_RETURN_SLIP';

ALTER TABLE "ManualReceipt"
  ADD COLUMN "status" "ManualReceiptStatus" NOT NULL DEFAULT 'ACTIVE';

ALTER TABLE "StockMovement"
  ADD COLUMN "manualReceiptReturnId" TEXT;

CREATE TABLE "ManualReceiptReturn" (
  "id" TEXT NOT NULL,
  "receiptId" TEXT NOT NULL,
  "status" "ReceiptReturnStatus" NOT NULL DEFAULT 'COMPLETED',
  "reason" TEXT NOT NULL,
  "refundMethod" "RefundMethod" NOT NULL,
  "refundAmount" DECIMAL(12,2) NOT NULL,
  "notes" TEXT,
  "idempotencyKey" TEXT,
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "cancelledAt" TIMESTAMP(3),
  "cancelledById" TEXT,
  CONSTRAINT "ManualReceiptReturn_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ManualReceiptReturnItem" (
  "id" TEXT NOT NULL,
  "returnId" TEXT NOT NULL,
  "manualReceiptItemId" TEXT NOT NULL,
  "productVariantId" TEXT,
  "quantity" INTEGER NOT NULL,
  "unitAmount" DECIMAL(10,2) NOT NULL,
  "refundAmount" DECIMAL(12,2) NOT NULL,
  CONSTRAINT "ManualReceiptReturnItem_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AuditLog" (
  "id" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "entityType" TEXT NOT NULL,
  "entityId" TEXT NOT NULL,
  "actorUserId" TEXT,
  "payload" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ManualReceipt_status_idx" ON "ManualReceipt"("status");
CREATE INDEX "StockMovement_manualReceiptReturnId_idx" ON "StockMovement"("manualReceiptReturnId");
CREATE UNIQUE INDEX "ManualReceiptReturn_idempotencyKey_key" ON "ManualReceiptReturn"("idempotencyKey");
CREATE INDEX "ManualReceiptReturn_receiptId_idx" ON "ManualReceiptReturn"("receiptId");
CREATE INDEX "ManualReceiptReturn_createdById_idx" ON "ManualReceiptReturn"("createdById");
CREATE INDEX "ManualReceiptReturn_cancelledById_idx" ON "ManualReceiptReturn"("cancelledById");
CREATE INDEX "ManualReceiptReturn_status_idx" ON "ManualReceiptReturn"("status");
CREATE INDEX "ManualReceiptReturn_createdAt_idx" ON "ManualReceiptReturn"("createdAt");
CREATE INDEX "ManualReceiptReturnItem_returnId_idx" ON "ManualReceiptReturnItem"("returnId");
CREATE INDEX "ManualReceiptReturnItem_manualReceiptItemId_idx" ON "ManualReceiptReturnItem"("manualReceiptItemId");
CREATE INDEX "ManualReceiptReturnItem_productVariantId_idx" ON "ManualReceiptReturnItem"("productVariantId");
CREATE INDEX "AuditLog_action_idx" ON "AuditLog"("action");
CREATE INDEX "AuditLog_entityType_entityId_idx" ON "AuditLog"("entityType", "entityId");
CREATE INDEX "AuditLog_actorUserId_idx" ON "AuditLog"("actorUserId");
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_manualReceiptReturnId_fkey"
  FOREIGN KEY ("manualReceiptReturnId") REFERENCES "ManualReceiptReturn"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ManualReceiptReturn" ADD CONSTRAINT "ManualReceiptReturn_receiptId_fkey"
  FOREIGN KEY ("receiptId") REFERENCES "ManualReceipt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ManualReceiptReturn" ADD CONSTRAINT "ManualReceiptReturn_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ManualReceiptReturn" ADD CONSTRAINT "ManualReceiptReturn_cancelledById_fkey"
  FOREIGN KEY ("cancelledById") REFERENCES "AdminUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ManualReceiptReturnItem" ADD CONSTRAINT "ManualReceiptReturnItem_returnId_fkey"
  FOREIGN KEY ("returnId") REFERENCES "ManualReceiptReturn"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ManualReceiptReturnItem" ADD CONSTRAINT "ManualReceiptReturnItem_manualReceiptItemId_fkey"
  FOREIGN KEY ("manualReceiptItemId") REFERENCES "ManualReceiptItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ManualReceiptReturnItem" ADD CONSTRAINT "ManualReceiptReturnItem_productVariantId_fkey"
  FOREIGN KEY ("productVariantId") REFERENCES "ProductVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorUserId_fkey"
  FOREIGN KEY ("actorUserId") REFERENCES "AdminUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

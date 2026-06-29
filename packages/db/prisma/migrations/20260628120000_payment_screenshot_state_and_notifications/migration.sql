-- Dedicated WhatsApp payment-screenshot state and persisted dashboard alerts.
ALTER TYPE "ConversationState" ADD VALUE IF NOT EXISTS 'AWAITING_PAYMENT_SCREENSHOT';

ALTER TABLE "Order"
  ADD COLUMN IF NOT EXISTS "paymentScreenshotMediaId" TEXT,
  ADD COLUMN IF NOT EXISTS "paymentSubmittedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "paymentCustomerWaId" TEXT,
  ADD COLUMN IF NOT EXISTS "paymentReceiverPhoneId" TEXT;

CREATE TABLE IF NOT EXISTS "DashboardNotification" (
  "id" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "body" TEXT,
  "entityType" TEXT,
  "entityId" TEXT,
  "orderId" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "readAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "DashboardNotification_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'DashboardNotification_orderId_fkey'
  ) THEN
    ALTER TABLE "DashboardNotification"
      ADD CONSTRAINT "DashboardNotification_orderId_fkey"
      FOREIGN KEY ("orderId") REFERENCES "Order"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "DashboardNotification_type_idx" ON "DashboardNotification"("type");
CREATE INDEX IF NOT EXISTS "DashboardNotification_entityType_entityId_idx" ON "DashboardNotification"("entityType", "entityId");
CREATE INDEX IF NOT EXISTS "DashboardNotification_orderId_idx" ON "DashboardNotification"("orderId");
CREATE INDEX IF NOT EXISTS "DashboardNotification_readAt_idx" ON "DashboardNotification"("readAt");
CREATE INDEX IF NOT EXISTS "DashboardNotification_createdAt_idx" ON "DashboardNotification"("createdAt");

-- Owner feedback / demo deployment update.
-- Additive and backward-compatible: old category strings and ADMIN role are kept.

ALTER TYPE "AdminRole" ADD VALUE IF NOT EXISTS 'OWNER';
ALTER TYPE "AdminRole" ADD VALUE IF NOT EXISTS 'MANAGER';

CREATE TYPE "OrderApprovalStatus" AS ENUM ('PENDING_OWNER_APPROVAL', 'APPROVED', 'REJECTED');
CREATE TYPE "PaymentMode" AS ENUM ('CASH', 'UPI', 'CARD', 'PAY_LATER');

ALTER TYPE "StockMovementType" ADD VALUE IF NOT EXISTS 'MANUAL_RECEIPT_DEDUCTION';

CREATE TABLE "Category" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Category_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Category_name_key" ON "Category"("name");
CREATE UNIQUE INDEX "Category_slug_key" ON "Category"("slug");
CREATE INDEX "Category_isActive_idx" ON "Category"("isActive");

ALTER TABLE "Product" ADD COLUMN "categoryId" TEXT;
ALTER TABLE "ProductVariant" ADD COLUMN "isActive" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Conversation" ADD COLUMN "supportNudgeSentAt" TIMESTAMP(3);
ALTER TABLE "Conversation" ADD COLUMN "supportRequestedAt" TIMESTAMP(3);
ALTER TABLE "Order" ADD COLUMN "approvalStatus" "OrderApprovalStatus" NOT NULL DEFAULT 'PENDING_OWNER_APPROVAL';
ALTER TABLE "Order" ADD COLUMN "approvedById" TEXT;
ALTER TABLE "Order" ADD COLUMN "approvedAt" TIMESTAMP(3);
ALTER TABLE "Order" ADD COLUMN "rejectedById" TEXT;
ALTER TABLE "Order" ADD COLUMN "rejectedAt" TIMESTAMP(3);
ALTER TABLE "Order" ADD COLUMN "rejectionReason" TEXT;

CREATE TABLE "ManualReceipt" (
  "id" TEXT NOT NULL,
  "receiptNumber" TEXT NOT NULL,
  "customerName" TEXT,
  "customerPhone" TEXT,
  "subtotal" DECIMAL(12,2) NOT NULL,
  "deliveryCharge" DECIMAL(10,2) NOT NULL DEFAULT 0,
  "discount" DECIMAL(10,2) NOT NULL DEFAULT 0,
  "totalAmount" DECIMAL(12,2) NOT NULL,
  "paymentMode" "PaymentMode" NOT NULL,
  "notes" TEXT,
  "createdById" TEXT NOT NULL,
  "printedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ManualReceipt_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ManualReceiptItem" (
  "id" TEXT NOT NULL,
  "manualReceiptId" TEXT NOT NULL,
  "productVariantId" TEXT NOT NULL,
  "quantity" INTEGER NOT NULL,
  "unitPrice" DECIMAL(10,2) NOT NULL,
  CONSTRAINT "ManualReceiptItem_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "StockMovement" ADD COLUMN "manualReceiptId" TEXT;

CREATE UNIQUE INDEX "ManualReceipt_receiptNumber_key" ON "ManualReceipt"("receiptNumber");
CREATE INDEX "ManualReceipt_receiptNumber_idx" ON "ManualReceipt"("receiptNumber");
CREATE INDEX "ManualReceipt_createdById_idx" ON "ManualReceipt"("createdById");
CREATE INDEX "ManualReceipt_createdAt_idx" ON "ManualReceipt"("createdAt");
CREATE INDEX "ManualReceipt_paymentMode_idx" ON "ManualReceipt"("paymentMode");
CREATE INDEX "ManualReceiptItem_manualReceiptId_idx" ON "ManualReceiptItem"("manualReceiptId");
CREATE INDEX "ManualReceiptItem_productVariantId_idx" ON "ManualReceiptItem"("productVariantId");
CREATE INDEX "Product_categoryId_idx" ON "Product"("categoryId");
CREATE INDEX "ProductVariant_isActive_idx" ON "ProductVariant"("isActive");
CREATE INDEX "Conversation_supportNudgeSentAt_idx" ON "Conversation"("supportNudgeSentAt");
CREATE INDEX "Conversation_supportRequestedAt_idx" ON "Conversation"("supportRequestedAt");
CREATE INDEX "Order_approvalStatus_idx" ON "Order"("approvalStatus");
CREATE INDEX "Order_approvedById_idx" ON "Order"("approvedById");
CREATE INDEX "Order_rejectedById_idx" ON "Order"("rejectedById");
CREATE INDEX "StockMovement_manualReceiptId_idx" ON "StockMovement"("manualReceiptId");

ALTER TABLE "Product" ADD CONSTRAINT "Product_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Order" ADD CONSTRAINT "Order_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "AdminUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Order" ADD CONSTRAINT "Order_rejectedById_fkey" FOREIGN KEY ("rejectedById") REFERENCES "AdminUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ManualReceipt" ADD CONSTRAINT "ManualReceipt_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ManualReceiptItem" ADD CONSTRAINT "ManualReceiptItem_manualReceiptId_fkey" FOREIGN KEY ("manualReceiptId") REFERENCES "ManualReceipt"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ManualReceiptItem" ADD CONSTRAINT "ManualReceiptItem_productVariantId_fkey" FOREIGN KEY ("productVariantId") REFERENCES "ProductVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_manualReceiptId_fkey" FOREIGN KEY ("manualReceiptId") REFERENCES "ManualReceipt"("id") ON DELETE SET NULL ON UPDATE CASCADE;

UPDATE "Order"
SET "approvalStatus" = 'APPROVED'
WHERE "status" IN ('VERIFIED', 'PRINTED', 'DISPATCHED');

UPDATE "Order"
SET "approvalStatus" = 'REJECTED'
WHERE "status" = 'REJECTED';

INSERT INTO "Category" ("id", "name", "slug", "isActive", "updatedAt")
VALUES
  (concat('cat_', md5('Co-ord Sets')), 'Co-ord Sets', 'co-ord-sets', true, CURRENT_TIMESTAMP),
  (concat('cat_', md5('Two-piece Kurtis')), 'Two-piece Kurtis', 'two-piece-kurtis', true, CURRENT_TIMESTAMP),
  (concat('cat_', md5('Three-piece Kurtis')), 'Three-piece Kurtis', 'three-piece-kurtis', true, CURRENT_TIMESTAMP),
  (concat('cat_', md5('Stitched Suits')), 'Stitched Suits', 'stitched-suits', true, CURRENT_TIMESTAMP)
ON CONFLICT ("slug") DO NOTHING;

INSERT INTO "Category" ("id", "name", "slug", "isActive", "updatedAt")
SELECT
  concat('cat_', md5(lower(trim("category")))),
  trim("category"),
  regexp_replace(regexp_replace(lower(trim("category")), '[^a-z0-9]+', '-', 'g'), '(^-|-$)', '', 'g'),
  true,
  CURRENT_TIMESTAMP
FROM (
  SELECT DISTINCT ON (lower(trim("category"))) "category"
  FROM "Product"
  WHERE trim("category") <> ''
  ORDER BY lower(trim("category")), "category"
) existing_categories
ON CONFLICT ("slug") DO NOTHING;

UPDATE "Product"
SET "categoryId" = "Category"."id"
FROM "Category"
WHERE lower(trim("Product"."category")) = lower(trim("Category"."name"));

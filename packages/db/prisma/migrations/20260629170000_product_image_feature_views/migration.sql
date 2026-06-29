ALTER TABLE "ProductImageFeature"
ADD COLUMN "cropBoxes" JSONB,
ADD COLUMN "featureSummary" JSONB,
ADD COLUMN "accessibilityStatus" TEXT NOT NULL DEFAULT 'valid',
ADD COLUMN "failureReason" TEXT;

CREATE INDEX "ProductImageFeature_accessibilityStatus_idx" ON "ProductImageFeature"("accessibilityStatus");

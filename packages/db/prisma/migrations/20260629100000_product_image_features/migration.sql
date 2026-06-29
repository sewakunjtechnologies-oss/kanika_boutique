CREATE TABLE "ProductImageFeature" (
    "id" TEXT NOT NULL,
    "sourceImageId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "imageUrl" TEXT NOT NULL,
    "imageHash" TEXT NOT NULL,
    "decodedImageHash" TEXT NOT NULL,
    "algorithmVersion" TEXT NOT NULL,
    "schemaVersion" INTEGER NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "format" TEXT,
    "averageHash" TEXT NOT NULL,
    "differenceHash" TEXT NOT NULL,
    "perceptualHash" TEXT NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductImageFeature_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProductImageFeature_sourceImageId_algorithmVersion_schemaVersion_key"
ON "ProductImageFeature"("sourceImageId", "algorithmVersion", "schemaVersion");

CREATE INDEX "ProductImageFeature_productId_idx" ON "ProductImageFeature"("productId");
CREATE INDEX "ProductImageFeature_imageHash_idx" ON "ProductImageFeature"("imageHash");
CREATE INDEX "ProductImageFeature_algorithmVersion_schemaVersion_idx"
ON "ProductImageFeature"("algorithmVersion", "schemaVersion");

ALTER TABLE "ProductImageFeature"
ADD CONSTRAINT "ProductImageFeature_productId_fkey"
FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

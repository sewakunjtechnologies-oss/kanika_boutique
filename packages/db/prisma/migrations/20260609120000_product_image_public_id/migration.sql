-- Add Cloudinary public_id for product photos (nullable for existing rows).
ALTER TABLE "Product" ADD COLUMN "imagePublicId" TEXT;

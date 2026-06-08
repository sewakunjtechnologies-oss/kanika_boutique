-- Notify boutique owner/admins once per payment screenshot.
ALTER TABLE "Order" ADD COLUMN "adminNotifiedAt" TIMESTAMP(3);

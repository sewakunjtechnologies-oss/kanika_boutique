-- Server-side dashboard sessions. Redis is the preferred store at runtime; this
-- table is the durable fallback when Redis is unavailable.
CREATE TABLE "AdminSession" (
  "id" TEXT NOT NULL,
  "data" JSONB NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "AdminSession_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AdminSession_expiresAt_idx" ON "AdminSession"("expiresAt");

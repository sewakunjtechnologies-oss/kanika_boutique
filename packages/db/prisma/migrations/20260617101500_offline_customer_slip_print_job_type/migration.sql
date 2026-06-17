DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'PrintJobType'
      AND e.enumlabel = 'OFFLINE_SLIP'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'PrintJobType'
      AND e.enumlabel = 'OFFLINE_CUSTOMER_SLIP'
  ) THEN
    ALTER TYPE "PrintJobType" RENAME VALUE 'OFFLINE_SLIP' TO 'OFFLINE_CUSTOMER_SLIP';
  END IF;
END $$;

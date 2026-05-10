-- ============================================================================
-- Migration 184: Add idempotency_key to refunds table
-- ============================================================================
-- 🔥 CRITICAL FIX: The refunds table was created in migration 180 without
-- the idempotency_key column, but the code references it. This migration
-- adds the missing column to prevent runtime failures.
--
-- Root cause: Migration 180 created the table without idempotency_key,
-- but paymentController.js line 549 and 183_refund_unique_constraints.sql
-- line 54 both reference this column.
--
-- Safety guarantees:
--   ✅ Idempotent — safe to re-run if migration was partially applied
--   ✅ No data loss — column added with NULL allowed initially
--   ✅ Backward compatible — existing rows unaffected
-- ============================================================================

BEGIN;

-- ── 1. Add idempotency_key column if it doesn't exist ────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'refunds' 
      AND column_name = 'idempotency_key'
  ) THEN
    ALTER TABLE refunds ADD COLUMN idempotency_key VARCHAR(255);
    RAISE NOTICE 'Added idempotency_key column to refunds table';
  ELSE
    RAISE NOTICE 'idempotency_key column already exists in refunds table';
  END IF;
END $$;

-- ── 2. Create index for efficient idempotency lookups ────────────────────────
-- This index helps with the idempotency check in paymentController.js
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_refunds_idempotency_key
  ON refunds(idempotency_key) 
  WHERE idempotency_key IS NOT NULL;

-- ── 3. Add unique constraint for idempotency safety ──────────────────────────
-- This prevents the same idempotency key from being used twice for the same payment
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints 
    WHERE table_name = 'refunds' 
      AND constraint_name = 'refunds_payment_idempotency_unique'
      AND constraint_type = 'UNIQUE'
  ) THEN
    ALTER TABLE refunds 
    ADD CONSTRAINT refunds_payment_idempotency_unique 
    UNIQUE (payment_id, idempotency_key);
    RAISE NOTICE 'Added unique constraint on (payment_id, idempotency_key)';
  ELSE
    RAISE NOTICE 'Unique constraint on (payment_id, idempotency_key) already exists';
  END IF;
END $$;

-- ── 4. Record migration ──────────────────────────────────────────────────────
INSERT INTO schema_migrations (version, filename, run_at)
VALUES ('184', '184_add_idempotency_key_to_refunds.sql', NOW())
ON CONFLICT (version) DO NOTHING;

COMMIT;

-- ============================================================================
-- Rollback:
--   ALTER TABLE refunds DROP CONSTRAINT IF EXISTS refunds_payment_idempotency_unique;
--   ALTER TABLE refunds DROP COLUMN IF EXISTS idempotency_key;
--   DROP INDEX IF EXISTS idx_refunds_idempotency_key;
--   DELETE FROM schema_migrations WHERE version = '184';
-- ============================================================================
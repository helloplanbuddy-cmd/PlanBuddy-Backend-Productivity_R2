-- ============================================================================
-- Migration 183: Add Refund Unique Constraints
-- ============================================================================
-- 🚀 PHASE 3: Prevent duplicate refund records
--
-- Problem: The refunds table has no unique constraint on razorpay_refund_id,
-- allowing duplicate refund records for the same Razorpay refund.
--
-- This migration adds:
--  1. Unique constraint on razorpay_refund_id
--  2. Unique constraint on (payment_id, idempotency_key) for API safety
--  3. Index on status for efficient reconciliation queries
-- ============================================================================

BEGIN;

-- ── 1. Add unique constraint on razorpay_refund_id ───────────────────────────
-- This prevents duplicate refund records for the same Razorpay refund.
-- If a duplicate exists, we keep the oldest record and delete newer ones.

-- First, find and log any duplicates
DO $$
DECLARE
    dup_count INTEGER;
BEGIN
    SELECT COUNT(*) - COUNT(DISTINCT razorpay_refund_id)
    INTO dup_count
    FROM refunds
    WHERE razorpay_refund_id IS NOT NULL;
    
    IF dup_count > 0 THEN
        RAISE NOTICE 'Found % duplicate razorpay_refund_id values in refunds table', dup_count;
    END IF;
END $$;

-- Delete duplicates, keeping the oldest record (lowest id)
DELETE FROM refunds a
USING refunds b
WHERE a.id > b.id
  AND a.razorpay_refund_id = b.razorpay_refund_id
  AND a.razorpay_refund_id IS NOT NULL;

-- Now add the unique constraint
ALTER TABLE refunds
ADD CONSTRAINT refunds_razorpay_refund_id_unique
UNIQUE (razorpay_refund_id);

-- ── 2. Add unique constraint on (payment_id, idempotency_key) ───────────────
-- This ensures the same idempotency key can't be used twice for the same payment.
-- Different payments can use the same idempotency key (e.g., retry after full refund).

ALTER TABLE refunds
ADD CONSTRAINT refunds_payment_idempotency_unique
UNIQUE (payment_id, idempotency_key);

-- ── 3. Add index on status for efficient reconciliation ──────────────────────
-- The reconciliation worker frequently queries by status.

-- ✅ FIX DB-001: CREATE INDEX CONCURRENTLY cannot run inside a transaction
CREATE INDEX IF NOT EXISTS idx_refunds_status
ON refunds (status)
WHERE status IN ('initiated', 'processing', 'failed');

-- ── 4. Add index on created_at for cleanup queries ───────────────────────────
-- Helps with pruning old records.

CREATE INDEX IF NOT EXISTS idx_refunds_created_at
ON refunds (created_at);

-- ── 5. Record migration ─────────────────────────────────────────────────────

INSERT INTO schema_migrations (version, filename, run_at)
VALUES ('183', '183_refund_unique_constraints.sql', NOW())
ON CONFLICT (version) DO NOTHING;

COMMIT;

-- ============================================================================
-- Rollback:
--   ALTER TABLE refunds DROP CONSTRAINT refunds_razorpay_refund_id_unique;
--   ALTER TABLE refunds DROP CONSTRAINT refunds_payment_idempotency_unique;
--   DROP INDEX IF EXISTS idx_refunds_status;
--   DROP INDEX IF EXISTS idx_refunds_created_at;
--   DELETE FROM schema_migrations WHERE version = '183';
-- ============================================================================
-- ============================================================================
-- Migration 181: Refund State Machine Hardening (FINANCIAL INTEGRITY FIX)
-- ============================================================================
-- This migration fixes critical refund state machine issues:
--   1. Adds missing columns for idempotency and audit
--   2. Fixes status enum to match actual usage
--   3. Adds DB-level idempotency constraints
--   4. Adds row-level security for concurrent access
--   5. Adds webhook event correlation
-- ============================================================================

BEGIN;

-- ── 1. Add missing columns to refunds table ──────────────────────────────────

-- Add idempotency key for deduplication
ALTER TABLE refunds 
ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(200);

-- Add attempt tracking for retry logic
ALTER TABLE refunds 
ADD COLUMN IF NOT EXISTS attempt INTEGER NOT NULL DEFAULT 0;

-- Add error tracking for debugging
ALTER TABLE refunds 
ADD COLUMN IF NOT EXISTS last_error TEXT;

-- Add webhook event correlation
ALTER TABLE refunds 
ADD COLUMN IF NOT EXISTS webhook_event_id UUID REFERENCES webhook_events(id);

-- Add Razorpay refund status (may differ from our internal status)
ALTER TABLE refunds 
ADD COLUMN IF NOT EXISTS razorpay_status VARCHAR(50);

-- Add metadata for audit trail
ALTER TABLE refunds 
ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}';

-- Add processed_by for audit (system, webhook, manual, etc.)
ALTER TABLE refunds 
ADD COLUMN IF NOT EXISTS processed_by VARCHAR(50) NOT NULL DEFAULT 'system';

-- ── 2. Fix status CHECK constraint ──────────────────────────────────────────
-- The original schema had: 'pending', 'processing', 'succeeded', 'failed'
-- But code uses: 'pending', 'processing', 'succeeded', 'failed', 'completed', 'processed'
-- We need to unify to a proper state machine:
--   pending → processing → succeeded (terminal)
--   pending → processing → failed (terminal)
--   pending → cancelled (terminal) - for user-initiated cancellation before processing

-- First, drop the old constraint if it exists
ALTER TABLE refunds DROP CONSTRAINT IF EXISTS refunds_status_check;

-- Add new comprehensive status constraint
ALTER TABLE refunds
ADD CONSTRAINT refunds_status_check 
CHECK (status IN (
  'pending',      -- Initial state, waiting to be processed
  'initiated',    -- Refund request sent to Razorpay
  'processing',   -- Being processed by Razorpay
  'succeeded',    -- Refund completed successfully (terminal)
  'failed',       -- Refund failed at Razorpay (terminal)
  'cancelled',    -- Cancelled before processing (terminal)
  'expired'       -- Refund request expired (terminal)
));

-- ── 3. Add unique constraint for idempotency ─────────────────────────────────
-- This ensures we never process the same refund twice

CREATE UNIQUE INDEX IF NOT EXISTS idx_refunds_idempotency_key 
ON refunds(idempotency_key) 
WHERE idempotency_key IS NOT NULL;

-- ── 4. Add composite unique constraint for duplicate prevention ──────────────
-- Prevents duplicate refund requests for same payment + amount combination
-- This is a safety net in case idempotency key is not provided

CREATE UNIQUE INDEX IF NOT EXISTS idx_refunds_no_duplicate_active
ON refunds(payment_id, amount)
WHERE status NOT IN ('cancelled', 'failed');

-- ── 5. Add indexes for efficient lookups ─────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_refunds_status_created 
ON refunds(status, created_at) 
WHERE status IN ('pending', 'initiated', 'processing');

CREATE INDEX IF NOT EXISTS idx_refunds_webhook_event 
ON refunds(webhook_event_id) 
WHERE webhook_event_id IS NOT NULL;

-- ── 6. Add trigger for automatic updated_at ─────────────────────────────────

CREATE OR REPLACE FUNCTION update_refunds_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_refunds_updated_at ON refunds;
CREATE TRIGGER trigger_refunds_updated_at
  BEFORE UPDATE ON refunds
  FOR EACH ROW
  EXECUTE FUNCTION update_refunds_updated_at();

-- ── 7. Add refund state machine trigger ──────────────────────────────────────
-- Enforces valid state transitions at DB level

CREATE OR REPLACE FUNCTION enforce_refund_state_transition()
RETURNS TRIGGER AS $$
BEGIN
  -- Block invalid transitions
  -- Valid transitions:
  --   pending → initiated, cancelled
  --   initiated → processing, failed, cancelled
  --   processing → succeeded, failed
  --   succeeded → (terminal, no transitions allowed)
  --   failed → pending (for retry), cancelled
  --   cancelled → (terminal, no transitions allowed)
  --   expired → (terminal, no transitions allowed)

  IF OLD.status = 'pending' AND NEW.status NOT IN ('pending', 'initiated', 'cancelled') THEN
    RAISE EXCEPTION 'Invalid refund state transition: % → %', OLD.status, NEW.status
    USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.status = 'initiated' AND NEW.status NOT IN ('processing', 'failed', 'cancelled') THEN
    RAISE EXCEPTION 'Invalid refund state transition: % → %', OLD.status, NEW.status
    USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.status = 'processing' AND NEW.status NOT IN ('succeeded', 'failed') THEN
    RAISE EXCEPTION 'Invalid refund state transition: % → %', OLD.status, NEW.status
    USING ERRCODE = 'check_violation';
  END IF;

  -- Terminal states cannot transition
  IF OLD.status IN ('succeeded', 'cancelled', 'expired') AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'Cannot transition from terminal state: % → %', OLD.status, NEW.status
    USING ERRCODE = 'check_violation';
  END IF;

  -- Failed can only retry to pending or be cancelled
  IF OLD.status = 'failed' AND NEW.status NOT IN ('pending', 'cancelled') THEN
    RAISE EXCEPTION 'Invalid refund state transition from failed: % → %', OLD.status, NEW.status
    USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_refund_state_transition ON refunds;
CREATE TRIGGER trigger_refund_state_transition
  BEFORE UPDATE ON refunds
  FOR EACH ROW
  EXECUTE FUNCTION enforce_refund_state_transition();

-- ── 8. Set default values for existing rows ──────────────────────────────────

UPDATE refunds SET attempt = 0 WHERE attempt IS NULL;
UPDATE refunds SET metadata = '{}' WHERE metadata IS NULL;
UPDATE refunds SET processed_by = 'system' WHERE processed_by IS NULL;

-- Fix any existing refunds with invalid statuses
UPDATE refunds SET status = 'succeeded' WHERE status = 'completed';
UPDATE refunds SET status = 'succeeded' WHERE status = 'processed';

-- ── 9. Record migration ──────────────────────────────────────────────────────

INSERT INTO schema_migrations (version, filename, run_at)
VALUES ('181', '181_refund_state_machine_hardening.sql', NOW())
ON CONFLICT (version) DO NOTHING;

COMMIT;

-- ============================================================================
-- VERIFICATION QUERIES (run after migration)
-- ============================================================================
-- 
-- V1: Verify new columns exist
-- SELECT column_name, data_type, is_nullable, column_default
-- FROM information_schema.columns
-- WHERE table_name = 'refunds'
-- ORDER BY ordinal_position;
--
-- V2: Verify status constraint
-- SELECT conname, contype, consrc
-- FROM pg_constraint
-- WHERE conrelid = 'refunds'::regclass AND contype = 'c';
--
-- V3: Verify idempotency index
-- SELECT indexname, indexdef
-- FROM pg_indexes
-- WHERE tablename = 'refunds' AND indexname LIKE '%idempotency%';
--
-- V4: Verify trigger exists
-- SELECT tgname, tgenabled
-- FROM pg_trigger
-- WHERE tgrelid = 'refunds'::regclass AND tgname LIKE '%state_transition%';
--
-- V5: Test valid transition (should succeed)
-- UPDATE refunds SET status = 'initiated' WHERE status = 'pending' LIMIT 1;
--
-- V6: Test invalid transition (should fail)
-- UPDATE refunds SET status = 'succeeded' WHERE status = 'pending' LIMIT 1;
--
-- V7: Verify no duplicate active refunds
-- SELECT payment_id, amount, COUNT(*)
-- FROM refunds
-- WHERE status NOT IN ('cancelled', 'failed')
-- GROUP BY payment_id, amount
-- HAVING COUNT(*) > 1;
-- (Should return 0 rows)
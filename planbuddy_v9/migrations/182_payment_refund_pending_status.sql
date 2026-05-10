-- ============================================================================
-- Migration 182: Add refund_pending status to payments table
-- ============================================================================
-- This migration adds the 'refund_pending' status to the payments table
-- to properly handle the intermediate state between refund initiation
-- and webhook confirmation.
-- ============================================================================

BEGIN;

-- Drop old constraint if exists
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_status_check;

-- Add new comprehensive status constraint including refund_pending
ALTER TABLE payments
ADD CONSTRAINT payments_status_check 
CHECK (status IN (
  'created',       -- Order created, awaiting payment
  'pending',       -- Payment initiated but not confirmed
  'captured',      -- Payment successfully captured
  'refund_pending', -- Refund initiated, awaiting webhook confirmation
  'refunded',      -- Refund completed (terminal)
  'partially_refunded', -- Partial refund completed (terminal)
  'failed',        -- Payment failed (terminal)
  'expired'        -- Payment expired (terminal)
));

-- Add index for refund_pending status for efficient reconciliation queries
CREATE INDEX IF NOT EXISTS idx_payments_refund_pending 
ON payments(status, updated_at) 
WHERE status = 'refund_pending';

-- Add index for payment status queries
CREATE INDEX IF NOT EXISTS idx_payments_status 
ON payments(status);

-- Add index for reconciliation of captured payments
CREATE INDEX IF NOT EXISTS idx_payments_captured 
ON payments(status, created_at) 
WHERE status = 'captured';

-- Migration tracking
INSERT INTO schema_migrations (version, filename, run_at)
VALUES ('182', '182_payment_refund_pending_status.sql', NOW())
ON CONFLICT (version) DO NOTHING;

COMMIT;
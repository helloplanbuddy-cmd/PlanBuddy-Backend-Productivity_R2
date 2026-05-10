-- ============================================================================
-- Migration 180: refunds table (payment refund tracking)
-- ============================================================================
-- Creates the refunds table for tracking refund operations.
-- This table is essential for payment integrity and audit trails.
-- ============================================================================

BEGIN;

-- Create refunds table if it doesn't exist
CREATE TABLE IF NOT EXISTS refunds (
  id                   UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  payment_id           UUID          NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
  booking_id           UUID          NOT NULL REFERENCES bookings(id) ON DELETE RESTRICT,
  user_id              UUID          NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  razorpay_refund_id   VARCHAR(100)  UNIQUE,
  razorpay_payment_id  VARCHAR(100)  NOT NULL,
  amount               NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  reason               VARCHAR(500),
  status               VARCHAR(20)   NOT NULL DEFAULT 'pending'
                                     CHECK (status IN ('pending', 'processing', 'succeeded', 'failed', 'initiated', 'cancelled', 'expired')),
  idempotency_key      VARCHAR(200),
  razorpay_status      VARCHAR(50),
  processed_by         VARCHAR(50)   NOT NULL DEFAULT 'system',
  metadata             JSONB         NOT NULL DEFAULT '{}',
  created_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ,
  processed_at         TIMESTAMPTZ
);

-- Indexes for efficient lookups
CREATE INDEX IF NOT EXISTS idx_refunds_payment_id ON refunds(payment_id);
CREATE INDEX IF NOT EXISTS idx_refunds_booking_id ON refunds(booking_id);
CREATE INDEX IF NOT EXISTS idx_refunds_user_id ON refunds(user_id);
CREATE INDEX IF NOT EXISTS idx_refunds_razorpay_refund_id ON refunds(razorpay_refund_id) WHERE razorpay_refund_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_refunds_razorpay_payment_id ON refunds(razorpay_payment_id);
CREATE INDEX IF NOT EXISTS idx_refunds_status ON refunds(status);
CREATE INDEX IF NOT EXISTS idx_refunds_created_at ON refunds(created_at);
CREATE INDEX IF NOT EXISTS idx_refunds_idempotency_key ON refunds(idempotency_key) WHERE idempotency_key IS NOT NULL;

-- Unique constraint for idempotency safety
CREATE UNIQUE INDEX IF NOT EXISTS idx_refunds_payment_idempotency_unique
ON refunds(payment_id, idempotency_key) 
WHERE idempotency_key IS NOT NULL;

-- Migration tracking
INSERT INTO schema_migrations (version, filename, run_at)
VALUES ('180', '180_refunds_table.sql', NOW())
ON CONFLICT (version) DO NOTHING;

COMMIT;
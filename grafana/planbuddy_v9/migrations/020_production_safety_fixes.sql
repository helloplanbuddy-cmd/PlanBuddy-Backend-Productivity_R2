-- Migration 020: Production safety fixes
-- Aligns schema with actual service layer usage discovered during audit.
--
-- Changes:
--  1. idempotency_keys: make request_hash and response_code nullable so
--     the payment idempotency path can insert without these fields.
--     NOTE: the recommended approach is to use the payments table UNIQUE
--     constraint on razorpay_payment_id — this migration keeps the table
--     compatible for any existing usage while removing the hard failure.
--
--  2. payments: ensure razorpay_payment_id has a UNIQUE constraint (may
--     have been added in 011/015 but guard here for safety).
--
--  3. razorpay_order_mappings: ensure table exists with correct structure
--     (referenced in razorpayService but no migration existed for it).
--
--  4. trips: add is_active flag used by dbService capacity check.
--
--  5. webhook_events: add missing correlation_id column for tracing.

BEGIN;

-- 1. Relax idempotency_keys constraints
ALTER TABLE idempotency_keys
  ALTER COLUMN request_hash  DROP NOT NULL,
  ALTER COLUMN response_code DROP NOT NULL,
  ALTER COLUMN response_body DROP NOT NULL;

ALTER TABLE idempotency_keys
  ALTER COLUMN request_hash  SET DEFAULT NULL,
  ALTER COLUMN response_code SET DEFAULT NULL,
  ALTER COLUMN response_body SET DEFAULT NULL;

-- 2. Payments: razorpay_payment_id unique (guard — may already exist)
ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS razorpay_payment_id VARCHAR(100),
  ADD COLUMN IF NOT EXISTS razorpay_order_id   VARCHAR(100),
  ADD COLUMN IF NOT EXISTS provider            VARCHAR(20) NOT NULL DEFAULT 'razorpay';

CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_razorpay_payment_id
  ON payments(razorpay_payment_id)
  WHERE razorpay_payment_id IS NOT NULL;

-- 3. Razorpay order → booking mapping table
CREATE TABLE IF NOT EXISTS razorpay_order_mappings (
  razorpay_order_id  VARCHAR(100) PRIMARY KEY,
  booking_id         UUID         NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  user_id            UUID         NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  amount             NUMERIC(12,2) NOT NULL,
  currency           CHAR(3)      NOT NULL DEFAULT 'INR',
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_razorpay_order_mappings_booking
  ON razorpay_order_mappings(booking_id);

-- 4. Trips: is_active flag
ALTER TABLE trips
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;

CREATE INDEX IF NOT EXISTS idx_trips_active
  ON trips(id) WHERE is_active = true;

-- 5. webhook_events: correlation_id for tracing
ALTER TABLE webhook_events
  ADD COLUMN IF NOT EXISTS correlation_id VARCHAR(100);

-- 6. reconciliation_log: add missing action column (referenced in worker)
ALTER TABLE reconciliation_log
  ADD COLUMN IF NOT EXISTS action         VARCHAR(50),
  ADD COLUMN IF NOT EXISTS correlation_id VARCHAR(100);

-- Track migration
INSERT INTO schema_migrations (version, filename)
VALUES ('020', '020_production_safety_fixes.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;

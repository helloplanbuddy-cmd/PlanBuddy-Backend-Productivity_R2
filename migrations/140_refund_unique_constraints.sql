-- =============================================================================
-- Migration 140: Refund Table Unique Constraints + Indexes
-- =============================================================================
-- Adds unique constraints that the refund-retry worker relies on for
-- idempotent INSERT ... ON CONFLICT semantics.
--
-- Referenced in workers/refund-retry.worker.js (Phase C) comments as
-- migrations 181/183/184. Consolidated here for clarity.
--
-- PREREQUISITE: migration 130_webhook_events_base_schema.sql must be applied.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. UNIQUE(razorpay_refund_id) — prevents duplicate refund records
--    for the same Razorpay refund object.
--    ON CONFLICT (razorpay_refund_id) DO NOTHING in Phase C.
-- ---------------------------------------------------------------------------

ALTER TABLE refunds
    DROP CONSTRAINT IF EXISTS refunds_razorpay_refund_id_key;

ALTER TABLE refunds
    ADD CONSTRAINT refunds_razorpay_refund_id_key
    UNIQUE (razorpay_refund_id);

-- ---------------------------------------------------------------------------
-- 2. UNIQUE(payment_id, idempotency_key) — prevents duplicate refund
--    attempts with the same worker-generated idempotency key.
--    ON CONFLICT (payment_id, idempotency_key) DO NOTHING in Phase A/C.
-- ---------------------------------------------------------------------------

ALTER TABLE refunds
    DROP CONSTRAINT IF EXISTS refunds_payment_id_idempotency_key_key;

ALTER TABLE refunds
    ADD CONSTRAINT refunds_payment_id_idempotency_key_key
    UNIQUE (payment_id, idempotency_key);

-- ---------------------------------------------------------------------------
-- 3. State machine CHECK constraint
-- ---------------------------------------------------------------------------

DO $$
DECLARE c text;
BEGIN
    SELECT conname INTO c FROM pg_constraint
    WHERE conrelid = 'refunds'::regclass AND contype = 'c' AND conname LIKE '%status%'
    LIMIT 1;
    IF c IS NOT NULL THEN EXECUTE format('ALTER TABLE refunds DROP CONSTRAINT %I', c); END IF;
END;
$$;

ALTER TABLE refunds
    ADD CONSTRAINT refunds_status_check
    CHECK (status IN ('initiated', 'processing', 'succeeded', 'failed', 'cancelled', 'expired'));

-- ---------------------------------------------------------------------------
-- 4. Supporting indexes
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_refunds_payment_id
    ON refunds (payment_id);

CREATE INDEX IF NOT EXISTS idx_refunds_razorpay_refund_id
    ON refunds (razorpay_refund_id)
    WHERE razorpay_refund_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_refunds_status
    ON refunds (status)
    WHERE status NOT IN ('succeeded', 'cancelled');

CREATE INDEX IF NOT EXISTS idx_refunds_idempotency_key
    ON refunds (idempotency_key)
    WHERE idempotency_key IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 5. payments table: ensure required columns exist
-- ---------------------------------------------------------------------------

ALTER TABLE payments
    ADD COLUMN IF NOT EXISTS razorpay_payment_id TEXT,
    ADD COLUMN IF NOT EXISTS razorpay_order_id   TEXT,
    ADD COLUMN IF NOT EXISTS status              TEXT NOT NULL DEFAULT 'created',
    ADD COLUMN IF NOT EXISTS updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW();

DO $$
DECLARE c text;
BEGIN
    SELECT conname INTO c FROM pg_constraint
    WHERE conrelid = 'payments'::regclass AND contype = 'c' AND conname LIKE '%status%'
    LIMIT 1;
    IF c IS NOT NULL THEN EXECUTE format('ALTER TABLE payments DROP CONSTRAINT %I', c); END IF;
END;
$$;

ALTER TABLE payments
    ADD CONSTRAINT payments_status_check
    CHECK (status IN ('created', 'captured', 'refund_pending', 'refunded', 'failed'));

COMMIT;

-- ============================================================
-- Migration 070 — PlanBuddy v4.0 Production Hardening (Phase 1)
-- 🔥 PHASE 1 FIX — ALL changes are idempotent & rollback-safe
-- ============================================================
-- Run AFTER all v3.0 migrations (000–060) are applied.
-- Every DDL uses IF NOT EXISTS / DO NOTHING / DO $$ guards.
-- ============================================================

BEGIN;

-- ─── 1. BOOKING LIFECYCLE: Add FAILED & EXPIRED states ───────────────────────
-- Extends the status CHECK to include 'failed' and 'expired' so the state
-- machine can express the full lifecycle:
--   PENDING → CONFIRMED → FAILED → EXPIRED
-- The old constraint only allowed: pending, confirmed, cancelled, completed
DO $$
BEGIN
  -- Drop old constraint and replace with the v4 definition
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'bookings' AND constraint_name = 'bookings_status_check'
  ) THEN
    ALTER TABLE bookings DROP CONSTRAINT bookings_status_check;
  END IF;

  ALTER TABLE bookings ADD CONSTRAINT bookings_status_check
    CHECK (status IN ('pending', 'confirmed', 'cancelled', 'completed', 'failed', 'expired'));

EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'bookings_status_check update: %', SQLERRM;
END;
$$;

-- ─── 2. BOOKING: Add slot_id column for fine-grained slot locking ─────────────
-- Required for the UNIQUE (trip_id, travel_date, slot_id) constraint.
-- Nullable so existing rows are unaffected; new bookings populate it.
ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS slot_id VARCHAR(100) DEFAULT NULL;

COMMENT ON COLUMN bookings.slot_id IS
  'v4.0: Optional named slot (e.g. morning/afternoon). Used for fine-grained dedup constraint.';

-- ─── 3. BOOKING: DB-level unique constraint on (trip_id, travel_date, slot_id) ─
-- 🔥 PHASE 1 FIX — Double-booking prevention at DB layer (second line of defence
-- after Redis lock + SELECT FOR UPDATE).
-- Partial: only enforces for non-cancelled/non-failed/non-expired bookings.
-- NULL slot_id is treated as a wildcard (no per-slot constraint fires).
CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_slot_unique
  ON bookings (trip_id, travel_date, slot_id)
  WHERE slot_id IS NOT NULL
    AND status NOT IN ('cancelled', 'failed', 'expired');

COMMENT ON INDEX idx_bookings_slot_unique IS
  'v4.0: Prevents double-booking the same slot on the same trip+date at DB level.';

-- ─── 4. PAYMENTS: Enforce ONE payment per booking (UNIQUE booking_id) ─────────
-- 🔥 PHASE 1 FIX — Guarantees the invariant: each booking has exactly ONE
-- payment record. The ON CONFLICT path in the service already handles this
-- at app level; this index makes it a hard DB guarantee.
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_booking_id_unique
  ON payments (booking_id);

COMMENT ON INDEX idx_payments_booking_id_unique IS
  'v4.0: Enforces 1-to-1 booking → payment relationship at DB level.';

-- ─── 5. PAYMENTS: Add 'created' status (Razorpay order created, not yet paid) ──
-- 🔥 PHASE 1 FIX — v3.0 schema only allows: created, captured, failed, refunded,
-- refund_failed. This step ensures 'created' is in the CHECK (it already is in
-- v3.0, so this is a no-op — but here for documentation completeness).
DO $$
BEGIN
  -- Verify 'created' is allowed; if someone removed it, add it back.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.check_constraints
    WHERE constraint_name = 'payments_status_check'
      AND check_clause LIKE '%created%'
  ) THEN
    ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_status_check;
    ALTER TABLE payments ADD CONSTRAINT payments_status_check
      CHECK (status IN ('created', 'captured', 'failed', 'refunded', 'refund_failed'));
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'payments_status_check verify: %', SQLERRM;
END;
$$;

-- ─── 6. WEBHOOK_AUDIT: Rich audit table for all webhook events ────────────────
-- 🔥 PHASE 1 FIX — Replaces basic webhook_events with a full audit trail.
-- Stores: signature validity, amount match, booking match, processing result.
CREATE TABLE IF NOT EXISTS webhook_audit (
  id                  UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  provider            VARCHAR(20)   NOT NULL DEFAULT 'razorpay',
  razorpay_event_id   VARCHAR(200),
  event_type          VARCHAR(100),
  -- Request metadata
  raw_payload         TEXT          NOT NULL,
  signature_header    VARCHAR(300),
  -- Verification results
  signature_valid     BOOLEAN       NOT NULL DEFAULT false,
  amount_matched      BOOLEAN,
  booking_id_matched  BOOLEAN,
  -- Resolution
  booking_id          UUID          REFERENCES bookings(id) ON DELETE SET NULL,
  payment_id          VARCHAR(100),
  processing_result   VARCHAR(30)   CHECK (processing_result IN (
                        'accepted', 'rejected_sig', 'rejected_replay',
                        'rejected_amount', 'duplicate', 'error'
                      )),
  error_message       TEXT,
  -- Timing
  received_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  processed_at        TIMESTAMPTZ,
  correlation_id      VARCHAR(100)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_webhook_audit_event_id
  ON webhook_audit (razorpay_event_id)
  WHERE razorpay_event_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_webhook_audit_booking_id
  ON webhook_audit (booking_id)
  WHERE booking_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_webhook_audit_received_at
  ON webhook_audit (received_at DESC);

CREATE INDEX IF NOT EXISTS idx_webhook_audit_result
  ON webhook_audit (processing_result, received_at DESC);

COMMENT ON TABLE webhook_audit IS
  'v4.0: Full audit trail for every inbound Razorpay webhook. '
  'Includes signature verification result, amount/booking match checks, '
  'and outcome. Used for fraud detection and reconciliation.';

-- ─── 7. IDEMPOTENCY: Add DB-fallback table for non-Redis environments ─────────
-- The primary store is Redis. This table is written when Redis is unavailable
-- and serves as a fallback so idempotency never silently degrades.
-- 🔥 PHASE 1 FIX — v3.0 table existed but was never written to (Redis replaced
-- it). v4.0 uses it as a hot-standby fallback.
ALTER TABLE idempotency_keys
  ADD COLUMN IF NOT EXISTS endpoint    VARCHAR(200),
  ADD COLUMN IF NOT EXISTS user_id_str VARCHAR(100),
  ADD COLUMN IF NOT EXISTS locked_at   TIMESTAMPTZ;

COMMENT ON TABLE idempotency_keys IS
  'v4.0: DB fallback for idempotency when Redis is unavailable. '
  'Primary store is Redis; this table is written on Redis failure.';

-- ─── 8. BOOKING: Add payment_link to track Razorpay order lifecycle ───────────
ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS razorpay_order_created_at TIMESTAMPTZ;

-- ─── 9. Performance indexes for v4.0 locking queries ─────────────────────────
-- Supports SELECT FOR UPDATE WHERE trip_id=? AND travel_date=? AND slot_id=?
CREATE INDEX IF NOT EXISTS idx_bookings_trip_date_slot
  ON bookings (trip_id, travel_date, slot_id)
  WHERE status NOT IN ('cancelled', 'failed', 'expired');

-- ─── 10. Record this migration ────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables WHERE table_name = 'schema_migrations'
  ) THEN
    INSERT INTO schema_migrations (version, description, applied_at)
    VALUES ('070', 'PlanBuddy v4.0 Phase 1 Production Hardening', NOW())
    ON CONFLICT (version) DO NOTHING;
  END IF;
END;
$$;

COMMIT;

-- ─── ROLLBACK SCRIPT (run manually if needed) ─────────────────────────────────
-- BEGIN;
-- DROP INDEX IF EXISTS idx_bookings_slot_unique;
-- DROP INDEX IF EXISTS idx_payments_booking_id_unique;
-- DROP INDEX IF EXISTS idx_bookings_trip_date_slot;
-- DROP TABLE IF EXISTS webhook_audit;
-- ALTER TABLE bookings DROP COLUMN IF EXISTS slot_id;
-- ALTER TABLE bookings DROP COLUMN IF EXISTS razorpay_order_created_at;
-- ALTER TABLE idempotency_keys DROP COLUMN IF EXISTS endpoint;
-- ALTER TABLE idempotency_keys DROP COLUMN IF EXISTS user_id_str;
-- ALTER TABLE idempotency_keys DROP COLUMN IF EXISTS locked_at;
-- -- Revert bookings status check to v3.0 definition:
-- ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_status_check;
-- ALTER TABLE bookings ADD CONSTRAINT bookings_status_check
--   CHECK (status IN ('pending', 'confirmed', 'cancelled', 'completed'));
-- ROLLBACK; -- (use COMMIT to apply rollback)

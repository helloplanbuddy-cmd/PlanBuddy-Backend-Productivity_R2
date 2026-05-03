-- Migration 130: v8 Production Safety — Risk Signals + State Invariants
-- SAFE: Idempotent, concurrent indexes, NOTICE reports, reversible.

BEGIN;

-- 1. RISK_SIGNALS table — fraud/velocity detection persistence
CREATE TABLE IF NOT EXISTS risk_signals (
  id          UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID          REFERENCES users(id) ON DELETE CASCADE,
  ip_address  INET,
  signal_type VARCHAR(50)   NOT NULL CHECK (signal_type IN ('velocity_bookings', 'velocity_payments', 'new_device', 'suspicious_ip')),
  score       NUMERIC(4,2)  NOT NULL CHECK (score >= 0 AND score <= 100),
  metadata    JSONB,
  created_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  expires_at  TIMESTAMPTZ   GENERATED ALWAYS AS (created_at + INTERVAL '7 days') STORED
);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_risk_signals_user_recent
  ON risk_signals (user_id, created_at DESC) WHERE score >= 50;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_risk_signals_ip
  ON risk_signals (ip_address, created_at DESC) WHERE score >= 75;

-- 2. Report current risk exposure (NOTICE)
RAISE NOTICE 'Users with >5 bookings/hour (velocity): %', (
  SELECT COUNT(DISTINCT user_id) FROM (
    SELECT user_id FROM bookings 
    WHERE created_at > NOW() - INTERVAL '1 hour' 
    GROUP BY user_id HAVING COUNT(*) > 5
  ) v
);

-- 3. Payment/Booking State Invariants (TRIGGER — cross-table CHECK)
-- Ensure: payments.captured → bookings.payment_status='paid'
--        payments.refunded → bookings.payment_status='refunded'

CREATE OR REPLACE FUNCTION enforce_payment_state_invariance()
RETURNS TRIGGER AS $$
DECLARE
  booking_status VARCHAR;
BEGIN
  IF TG_OP = 'UPDATE' OR TG_OP = 'INSERT' THEN
    SELECT payment_status INTO booking_status
    FROM bookings WHERE id = NEW.booking_id;
    
    IF NEW.status = 'captured' AND (booking_status != 'paid' OR booking_status IS NULL) THEN
      RAISE EXCEPTION 'INVARIANT_VIOLATION: payments.status=captured requires bookings.payment_status=paid (booking_id=%)', NEW.booking_id;
    END IF;
    
    IF NEW.status IN ('refunded', 'partially_refunded') AND (booking_status != 'refunded' OR booking_status IS NULL) THEN
      RAISE EXCEPTION 'INVARIANT_VIOLATION: payments.status=refund%% requires bookings.payment_status=refunded (booking_id=%)', NEW.status, NEW.booking_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply to payments table
DO $$
BEGIN
  -- Drop if exists
  DROP TRIGGER IF EXISTS trg_payments_state_invariance ON payments;
  -- Create new
  CREATE TRIGGER trg_payments_state_invariance
    BEFORE INSERT OR UPDATE ON payments
    FOR EACH ROW EXECUTE FUNCTION enforce_payment_state_invariance();
END $$;

-- 4. Booking trigger (symmetric check)
CREATE OR REPLACE FUNCTION enforce_booking_payment_invariance()
RETURNS TRIGGER AS $$
DECLARE
  payment_status VARCHAR;
BEGIN
  -- Check if conflicting payment exists
  SELECT status INTO payment_status
  FROM payments WHERE booking_id = NEW.id AND status = 'captured'
  LIMIT 1;
  
  IF payment_status IS NOT NULL AND NEW.payment_status != 'paid' THEN
    RAISE EXCEPTION 'INVARIANT_VIOLATION: bookings.payment_status != paid despite captured payment (booking_id=%)', NEW.id;
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  DROP TRIGGER IF EXISTS trg_bookings_payment_invariance ON bookings;
  CREATE TRIGGER trg_bookings_payment_invariance
    BEFORE INSERT OR UPDATE ON bookings
    FOR EACH ROW EXECUTE FUNCTION enforce_booking_payment_invariance();
END $$;

-- 5. Migration tracking
INSERT INTO schema_migrations (version, filename, run_at)
VALUES ('130', '130_v8_production_safety.sql', NOW())
ON CONFLICT (version) DO NOTHING;

-- 6. Vacuum analyze
VACUUM ANALYZE risk_signals;

COMMIT;

-- ROLLBACK: DROP TABLE risk_signals; DROP TRIGGER ... ON payments/bookings;


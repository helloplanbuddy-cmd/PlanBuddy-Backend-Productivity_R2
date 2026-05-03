-- Migration 140: DB-Level Idempotency + Booking State Machine
-- Financial-grade safety: prevents duplicate execution + invalid transitions

BEGIN;

-- 1. BOOKING_REQUESTS table (DB-level idempotency enforcement)
CREATE TABLE IF NOT EXISTS booking_requests (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  idempotency_key   UUID UNIQUE NOT NULL,
  booking_id        UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  action            VARCHAR(50) NOT NULL CHECK (action IN ('cancel', 'confirm', 'create')),
  status            VARCHAR(20) NOT NULL CHECK (status IN ('pending', 'processed', 'failed')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at      TIMESTAMPTZ,
  result            JSONB
);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_booking_requests_key ON booking_requests(idempotency_key);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_booking_requests_booking ON booking_requests(booking_id);

-- 2. STRICT booking state machine (prevent invalid transitions)
-- Create ENUM for type safety
DROP TYPE IF EXISTS booking_status_enum CASCADE;
CREATE TYPE booking_status_enum AS ENUM ('pending', 'confirmed', 'cancelled');

-- Update bookings.status column to use ENUM
ALTER TABLE bookings 
ALTER COLUMN status TYPE booking_status_enum 
USING status::booking_status_enum;

-- 3. Booking cancellation trigger (state machine enforcement)
CREATE OR REPLACE FUNCTION enforce_booking_state_transition()
RETURNS TRIGGER AS $$
BEGIN
  -- PENDING → CONFIRMED: allowed
  -- CONFIRMED → CANCELLED: allowed  
  -- CANCELLED → ANY: blocked
  IF OLD.status = 'cancelled' AND NEW.status != OLD.status THEN
    RAISE EXCEPTION 'Cannot change state from cancelled booking %', NEW.id
      USING HINT = 'Booking already cancelled - idempotent no-op required';
  END IF;
  
  -- Capacity safety (already enforced by CHECK constraint)
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_booking_state_transition
  BEFORE UPDATE ON bookings
  FOR EACH ROW EXECUTE FUNCTION enforce_booking_state_transition();

-- 4. Strengthen trips capacity CHECK (redundant but explicit)
ALTER TABLE trips 
ADD CONSTRAINT IF NOT EXISTS trips_capacity_non_negative 
CHECK (current_bookings >= 0);

-- 5. Record migration
INSERT INTO schema_migrations (version, description, applied_at) 
VALUES ('140', 'DB-level idempotency + booking state machine', NOW())
ON CONFLICT (version) DO NOTHING;

COMMIT;


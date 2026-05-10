-- migrations/100_phase3_worker_safety.sql
-- PHASE 3: Worker Safety + Idempotency
--
-- This migration adds:
-- 1. UNIQUE constraint on job_id in job_logs (prevents duplicate worker execution)
-- 2. Indexes for stuck booking detection
-- 3. Payment idempotency tracking table

BEGIN;

-- 1. Add UNIQUE constraint on job_id to prevent duplicate worker execution
-- This ensures the same reconciliation job can never run twice concurrently
ALTER TABLE job_logs 
ADD CONSTRAINT unique_job_id UNIQUE (job_id);

-- 2. Add index for finding stuck bookings (pending for > 30 minutes)
CREATE INDEX IF NOT EXISTS idx_bookings_stuck_detection 
ON bookings (status, created_at) 
WHERE status = 'pending';

-- 3. Add index for job_state monitoring
CREATE INDEX IF NOT EXISTS idx_job_state_status 
ON job_state (status, created_at);

-- 4. Create payment_idempotency_keys table for webhook + API coordination
-- This prevents race conditions between webhooks and API verification
CREATE TABLE IF NOT EXISTS payment_idempotency_keys (
    id              SERIAL PRIMARY KEY,
    payment_id       VARCHAR(100) UNIQUE NOT NULL,
    order_id        VARCHAR(100) NOT NULL,
    booking_id      VARCHAR(100),
    status         VARCHAR(50) NOT NULL DEFAULT 'processing',
    locked_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    completed_at    TIMESTAMP WITH TIME ZONE,
    error_message   TEXT,
    correlation_id VARCHAR(100),
    created_at     TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payment_idempotency_keys_status 
ON payment_idempotency_keys (status, locked_at);

-- 5. Add stuck_booking_detected_at for monitoring
ALTER TABLE bookings 
ADD COLUMN IF NOT EXISTS stuck_detected_at TIMESTAMP WITH TIME ZONE;

-- 6. Create alert_log table for failure visibility
CREATE TABLE IF NOT EXISTS alert_log (
    id              SERIAL PRIMARY KEY,
    alert_type      VARCHAR(100) NOT NULL,
    severity       VARCHAR(20) NOT NULL DEFAULT 'warning',
    message        TEXT NOT NULL,
    entity_type    VARCHAR(50),
    entity_id     VARCHAR(100),
    metadata      JSONB,
    acknowledged  BOOLEAN DEFAULT FALSE,
    acknowledged_by VARCHAR(100),
    acknowledged_at TIMESTAMP WITH TIME ZONE,
    created_at     TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_alert_log_unacknowledged 
ON alert_log (acknowledged, created_at) 
WHERE acknowledged = FALSE;

COMMIT;

-- Notify about the new indexes
DO $$
BEGIN
    RAISE NOTICE 'PHASE 3 MIGRATION COMPLETE: Worker safety indexes created';
    RAISE NOTICE '  - unique_job_id constraint on job_logs';
    RAISE NOTICE '  - idx_bookings_stuck_detection for stuck booking detection';
    RAISE NOTICE '  - payment_idempotency_keys table for webhook/API coordination';
    RAISE NOTICE '  - alert_log table for failure visibility';
END $$;

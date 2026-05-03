-- Phase 4: Payment Recovery & Observability
-- Run: psql -d planbuddy -f migrations/110_phase4_payment_recovery.sql

-- 1. Payment Reconciliation Logs (idempotent reconciliation tracking)
CREATE TABLE IF NOT EXISTS payment_reconciliation_logs (
    id SERIAL PRIMARY KEY,
    payment_id VARCHAR(50) NOT NULL,
    razorpay_payment_id VARCHAR(100),
    booking_id VARCHAR(50),
    status_before VARCHAR(20),
    status_after VARCHAR(20),
    action_taken VARCHAR(50) NOT NULL,
    amount DECIMAL(12, 2),
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reconciliation_payment_id 
ON payment_reconciliation_logs(payment_id);
CREATE INDEX IF NOT EXISTS idx_reconciliation_booking_id 
ON payment_reconciliation_logs(booking_id);
CREATE INDEX IF NOT EXISTS idx_reconciliation_created 
ON payment_reconciliation_logs(created_at DESC);

-- 2. Circuit Breaker State
CREATE TABLE IF NOT EXISTS circuit_breaker_state (
    id SERIAL PRIMARY KEY,
    service_name VARCHAR(50) UNIQUE NOT NULL,
    state VARCHAR(20) NOT NULL DEFAULT 'CLOSED',
    failure_count INT DEFAULT 0,
    success_count INT DEFAULT 0,
    opened_at TIMESTAMP,
    closed_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

INSERT INTO circuit_breaker_state (service_name, state) 
VALUES 
    ('razorpay', 'CLOSED'),
    ('redis', 'CLOSED'),
    ('email', 'CLOSED')
ON CONFLICT (service_name) DO NOTHING;

-- 3. Risk Events
CREATE TABLE IF NOT EXISTS risk_events (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(50) NOT NULL,
    risk_type VARCHAR(50) NOT NULL,
    severity VARCHAR(20) NOT NULL DEFAULT 'medium',
    metadata JSONB,
    blocked BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_risk_user_id 
ON risk_events(user_id);
CREATE INDEX IF NOT EXISTS idx_risk_created 
ON risk_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_risk_type 
ON risk_events(risk_type);

-- 4. Booking Recovery Fields
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS reconciliation_checked_at TIMESTAMP;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS last_recovery_attempt TIMESTAMP;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS recovery_count INT DEFAULT 0;

-- 5. Worker Health Monitoring
ALTER TABLE worker_jobs ADD COLUMN IF NOT EXISTS attempts_count INT DEFAULT 0;
ALTER TABLE worker_jobs ADD COLUMN IF NOT EXISTS last_error TEXT;
ALTER TABLE worker_jobs ADD COLUMN IF NOT EXISTS last_heartbeat TIMESTAMP;

-- 6. Add observability columns to bookings
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payment_attempts INT DEFAULT 0;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS last_payment_error TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS webhook_received_at TIMESTAMP;

-- 7. Alert History Table
CREATE TABLE IF NOT EXISTS alert_history (
    id SERIAL PRIMARY KEY,
    alert_type VARCHAR(50) NOT NULL,
    severity VARCHAR(20) NOT NULL,
    message TEXT NOT NULL,
    entity_type VARCHAR(50),
    entity_id VARCHAR(50),
    metadata JSONB,
    resolved_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_alert_history_entity 
ON alert_history(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_alert_history_created 
ON alert_history(created_at DESC);

-- 8. Add payment attempt tracking
ALTER TABLE payments ADD COLUMN IF NOT EXISTS verification_attempts INT DEFAULT 0;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS last_verification_error TEXT;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS verified_at TIMESTAMP;

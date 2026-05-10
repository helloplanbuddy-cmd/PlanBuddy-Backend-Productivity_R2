-- =============================================================================
-- Migration 040: Missing Production Tables
-- Adds all tables referenced in services but not yet in schema
-- Run after: 030_password_reset_tokens.sql
-- =============================================================================

BEGIN;

-- ─── 1. token_blacklist — JWT revocation on logout/password-change ─────────────
-- Without this, logging out is purely advisory (client discards the token,
-- but a stolen token remains valid until expiry). This table lets us
-- explicitly invalidate tokens server-side.
CREATE TABLE IF NOT EXISTS token_blacklist (
  jti         VARCHAR(36)  PRIMARY KEY,   -- JWT ID claim (uuid)
  user_id     UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  TIMESTAMPTZ  NOT NULL,       -- mirrors JWT exp — used to purge old rows
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_token_blacklist_expires_at
  ON token_blacklist(expires_at);

CREATE INDEX IF NOT EXISTS idx_token_blacklist_user_id
  ON token_blacklist(user_id);

-- ─── 2. audit_log — immutable write-ahead trail of sensitive mutations ──────────
-- Required for financial compliance. Captures who changed what and when,
-- with before/after snapshots for bookings and payments.
CREATE TABLE IF NOT EXISTS audit_log (
  id           UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id      UUID         REFERENCES users(id) ON DELETE SET NULL,
  action       VARCHAR(100) NOT NULL,      -- e.g. 'booking.created', 'payment.captured'
  entity_type  VARCHAR(50)  NOT NULL,      -- 'booking' | 'payment' | 'trip' | 'user'
  entity_id    UUID,                        -- FK to the mutated record
  before_data  JSONB,                       -- snapshot before mutation (NULL for creates)
  after_data   JSONB,                       -- snapshot after mutation (NULL for deletes)
  ip_address   INET,
  user_agent   VARCHAR(500),
  request_id   VARCHAR(100),
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_entity   ON audit_log(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_user_id  ON audit_log(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_created  ON audit_log(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_log_action   ON audit_log(action);

-- ─── 3. distributed_locks — advisory locking via DB when Redis unavailable ─────
-- Backup locking mechanism. Primary locking is DB-level SELECT FOR UPDATE.
-- This table supports application-level named locks for cross-process coordination.
CREATE TABLE IF NOT EXISTS distributed_locks (
  lock_key    VARCHAR(200) PRIMARY KEY,
  owner       VARCHAR(100) NOT NULL,   -- identifier of lock holder (e.g. process PID)
  expires_at  TIMESTAMPTZ  NOT NULL,
  acquired_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_distributed_locks_expires_at
  ON distributed_locks(expires_at);

-- ─── 4. payment_state_transitions — explicit state machine audit trail ───────
-- Records every payment state change for debugging disputed payments.
CREATE TABLE IF NOT EXISTS payment_state_transitions (
  id            UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  payment_id    UUID        NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  from_status   VARCHAR(20),             -- NULL on creation
  to_status     VARCHAR(20) NOT NULL,
  triggered_by  VARCHAR(50) NOT NULL,    -- 'webhook' | 'verify' | 'refund' | 'reconcile'
  correlation_id VARCHAR(100),
  metadata      JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pst_payment_id  ON payment_state_transitions(payment_id);
CREATE INDEX IF NOT EXISTS idx_pst_created_at  ON payment_state_transitions(created_at);

-- ─── 5. Add razorpay_refund_id to payments (needed by refundService) ──────────
ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS razorpay_refund_id VARCHAR(100),
  ADD COLUMN IF NOT EXISTS refund_notes        JSONB,
  ADD COLUMN IF NOT EXISTS notes               JSONB,
  ADD COLUMN IF NOT EXISTS refunded_at         TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_razorpay_refund_id
  ON payments(razorpay_refund_id)
  WHERE razorpay_refund_id IS NOT NULL;

-- ─── 6. reconciliation_log: add missing columns ───────────────────────────────
ALTER TABLE reconciliation_log
  ADD COLUMN IF NOT EXISTS amount             NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS razorpay_refund_id VARCHAR(100),
  ADD COLUMN IF NOT EXISTS initiated_by       UUID REFERENCES users(id) ON DELETE SET NULL;

-- ─── 7. bookings: add cancellation_reason length extension + index ─────────────
-- Already exists in 000 schema but enforce index for fast lookup
CREATE INDEX IF NOT EXISTS idx_bookings_payment_status
  ON bookings(payment_status);

CREATE INDEX IF NOT EXISTS idx_bookings_created_at
  ON bookings(created_at);

-- ─── 8. users: add failed_login_attempts for account lockout ──────────────────
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS failed_login_attempts INTEGER     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS locked_until          TIMESTAMPTZ;

-- ─── Track migration ───────────────────────────────────────────────────────────
INSERT INTO schema_migrations (version, filename)
VALUES ('040', '040_missing_production_tables.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;

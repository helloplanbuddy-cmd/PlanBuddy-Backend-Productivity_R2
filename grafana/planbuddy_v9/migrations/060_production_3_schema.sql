-- ============================================================
-- Migration 060 — Production 3.0 Schema Additions
-- Run AFTER all v2.0 migrations (000–050) are applied.
-- Idempotent: all statements use IF NOT EXISTS / DO NOTHING.
-- ============================================================

-- ─── 1. Add password_changed_at to users (RISK-001 fix) ───────────────────────
-- Tokens issued before this timestamp are rejected by auth middleware.
-- On password reset: UPDATE users SET password_changed_at = NOW() WHERE id = $1
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ DEFAULT NULL;

COMMENT ON COLUMN users.password_changed_at IS
  'Set on password reset. Auth middleware rejects tokens issued before this timestamp (RISK-001).';

-- ─── 2. Add payments.status CHECK constraint for refund_failed (RISK schema fix) ─
-- v2.0 schema: CHECK only allows created/captured/failed/refunded
-- v3.0: adds refund_failed (used by refundService + webhook handler)
-- NOTE: If this constraint already exists with the old definition, drop and recreate.
DO $$
BEGIN
  -- Try to drop the old constraint if it exists
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'payments'
      AND constraint_name = 'payments_status_check'
  ) THEN
    ALTER TABLE payments DROP CONSTRAINT payments_status_check;
  END IF;

  -- Add updated constraint
  ALTER TABLE payments ADD CONSTRAINT payments_status_check
    CHECK (status IN ('created', 'captured', 'failed', 'refunded', 'refund_failed'));

EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Could not update payments_status_check: %', SQLERRM;
END;
$$;

-- ─── 3. dead_letter_jobs table (replaces reconciliation_log-based DLQ) ────────
CREATE TABLE IF NOT EXISTS dead_letter_jobs (
  id            UUID        NOT NULL DEFAULT uuid_generate_v4() PRIMARY KEY,
  queue         VARCHAR(50) NOT NULL,
  job_name      VARCHAR(100),
  payload       JSONB       NOT NULL,
  error_message TEXT,
  error_stack   TEXT,
  retry_count   INTEGER     NOT NULL DEFAULT 0,
  max_retries   INTEGER     NOT NULL DEFAULT 5,
  next_retry_at TIMESTAMPTZ,
  status        VARCHAR(20) NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'retrying', 'exhausted', 'resolved')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ,
  resolved_at   TIMESTAMPTZ,
  resolved_by   UUID        REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_dlj_status_retry
  ON dead_letter_jobs (status, next_retry_at)
  WHERE status IN ('pending', 'retrying');

CREATE INDEX IF NOT EXISTS idx_dlj_queue_created
  ON dead_letter_jobs (queue, created_at DESC);

COMMENT ON TABLE dead_letter_jobs IS
  'v3.0: Structured DLQ replacing reconciliation_log-based retry tracking. '
  'BullMQ failed jobs that exhaust retries are persisted here for manual review.';

-- ─── 4. idempotency_keys table (legacy cleanup — now Redis-backed in v3.0) ────
-- Keep the table for backward compatibility; maintenance worker still purges it.
-- New idempotency is handled entirely in Redis. No schema change needed.

-- ─── 5. Index: token_blacklist expires_at (speeds up purge + isRevoked fallback) ─
CREATE INDEX IF NOT EXISTS idx_token_blacklist_expires_at
  ON token_blacklist (expires_at);

CREATE INDEX IF NOT EXISTS idx_token_blacklist_user_id
  ON token_blacklist (user_id);

-- ─── 6. Index: bookings user_id + status (for auth cancel + history queries) ──
CREATE INDEX IF NOT EXISTS idx_bookings_user_status
  ON bookings (user_id, status);

-- ─── 7. Index: payments booking_id + status (for refund orphan detection) ─────
CREATE INDEX IF NOT EXISTS idx_payments_booking_status
  ON payments (booking_id, status);

-- ─── 8. Partial index: pending bookings with expiry (expiry worker) ────────────
CREATE INDEX IF NOT EXISTS idx_bookings_pending_expired
  ON bookings (expires_at)
  WHERE status = 'pending';

-- ─── 9. Record this migration ─────────────────────────────────────────────────
-- Only if schema_migrations table exists (created by migrate-safe.js)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables WHERE table_name = 'schema_migrations'
  ) THEN
    INSERT INTO schema_migrations (version, description, applied_at)
    VALUES ('060', 'Production 3.0 schema additions', NOW())
    ON CONFLICT (version) DO NOTHING;
  END IF;
END;
$$;

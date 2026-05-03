-- ============================================================
-- Migration 090 — PlanBuddy v6.0 Full Observability
-- 🚀 PHASE 2B — Payment Audit Logs + Observability Schema
-- ============================================================
-- Adds:
--   1. payment_audit_logs — full payment event audit trail
--   2. Indexes for fast audit queries by booking_id, payment_id, event_type
-- All DDL is idempotent (IF NOT EXISTS / DO NOTHING guards).
-- ============================================================

BEGIN;

-- ─── 1. PAYMENT AUDIT LOGS TABLE ──────────────────────────────────────────────
-- Stores every significant payment lifecycle event:
--   payment_created, webhook_received, webhook_verified, webhook_failed,
--   payment_verified, payment_captured, refund_initiated, refund_processed, refund_failed
--
-- This is the SINGLE SOURCE OF TRUTH for payment traceability.
-- Every row links booking_id + payment_id + event_type + raw_payload + trace_id.

CREATE TABLE IF NOT EXISTS payment_audit_logs (
  id             UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- Core linkage
  booking_id     UUID          REFERENCES bookings(id) ON DELETE SET NULL,
  payment_id     VARCHAR(100),  -- razorpay_payment_id, order_id, refund_id, event_id

  -- Event
  event_type     VARCHAR(50)   NOT NULL
                   CHECK (event_type IN (
                     'payment_created',
                     'webhook_received',
                     'webhook_verified',
                     'webhook_failed',
                     'payment_verified',
                     'payment_captured',
                     'refund_initiated',
                     'refund_processed',
                     'refund_failed'
                   )),

  -- Raw event data (truncated to 10KB for storage safety)
  raw_payload    TEXT,

  -- Observability fields
  trace_id       VARCHAR(200),
  user_id        UUID,
  error_message  TEXT,
  metadata       JSONB,

  -- Timestamp
  created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- ─── Indexes ──────────────────────────────────────────────────────────────────

-- Fast lookup by booking (most common query: "trace all events for booking X")
CREATE INDEX IF NOT EXISTS idx_payment_audit_booking_id
  ON payment_audit_logs (booking_id, created_at DESC);

-- Fast lookup by payment_id (webhook/reconciliation correlation)
CREATE INDEX IF NOT EXISTS idx_payment_audit_payment_id
  ON payment_audit_logs (payment_id, created_at DESC);

-- Filter by event type (admin dashboard: "all webhook failures today")
CREATE INDEX IF NOT EXISTS idx_payment_audit_event_type
  ON payment_audit_logs (event_type, created_at DESC);

-- Trace correlation (distributed tracing: "all events for trace X")
CREATE INDEX IF NOT EXISTS idx_payment_audit_trace_id
  ON payment_audit_logs (trace_id)
  WHERE trace_id IS NOT NULL;

-- Time-based queries (audit log retention / cleanup)
CREATE INDEX IF NOT EXISTS idx_payment_audit_created_at
  ON payment_audit_logs (created_at DESC);

COMMENT ON TABLE payment_audit_logs IS
  'v6.0: Full payment lifecycle audit trail. '
  'Every payment event (created, webhook, captured, refund) is logged here. '
  'Links booking_id + payment_id + trace_id for complete traceability.';

COMMENT ON COLUMN payment_audit_logs.trace_id IS
  'X-Trace-Id from the originating HTTP request (AsyncLocalStorage propagated). '
  'Allows correlation of all log lines for a single request.';

COMMENT ON COLUMN payment_audit_logs.raw_payload IS
  'Truncated raw event payload (max 10KB). '
  'For webhook events: Razorpay payload. '
  'For payment_created: Razorpay order details.';

-- ─── 2. Record migration ──────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables WHERE table_name = 'schema_migrations'
  ) THEN
    INSERT INTO schema_migrations (version, description, applied_at)
    VALUES ('090', 'PlanBuddy v6.0 Full Observability — payment_audit_logs', NOW())
    ON CONFLICT (version) DO NOTHING;
  END IF;
END;
$$;

COMMIT;

-- ─── ROLLBACK SCRIPT ─────────────────────────────────────────────────────────
-- BEGIN;
-- DROP TABLE IF EXISTS payment_audit_logs CASCADE;
-- ROLLBACK; -- change to COMMIT to apply rollback

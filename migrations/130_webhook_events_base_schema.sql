-- =============================================================================
-- Migration 130: Webhook Events Base Schema
-- =============================================================================
-- Creates the foundational webhook_events table that migration 120 depends on.
-- If the table already exists from a prior deployment, all statements are
-- idempotent (CREATE TABLE IF NOT EXISTS, ADD COLUMN IF NOT EXISTS).
--
-- This migration must run BEFORE 120_webhook_idempotency_constraints.sql.
-- PREREQUISITE: None
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Canonical webhook_events table
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS webhook_events (
    id                  BIGSERIAL       PRIMARY KEY,
    event_id            TEXT            NOT NULL,   -- logical event identity (Razorpay razorpay_event_id or synthetic)
    provider            TEXT            NOT NULL DEFAULT 'razorpay',
    provider_event_id   TEXT,                       -- populated in migration 120
    type                TEXT,                       -- event type (payment.captured, refund.created, ...)
    event_type          TEXT,                       -- alias for type (used by webhook worker)
    payload             JSONB           NOT NULL DEFAULT '{}',
    status              TEXT            NOT NULL DEFAULT 'received',
    correlation_id      TEXT,
    error_message       TEXT,
    attempt_count       INTEGER         NOT NULL DEFAULT 0,
    lease_version       INTEGER,
    lease_expires_at    TIMESTAMPTZ,
    last_attempt_at     TIMESTAMPTZ,
    processed_at        TIMESTAMPTZ,
    razorpay_event_id   TEXT,                       -- backward compat (= event_id for razorpay provider)
    created_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

-- Ensure all columns exist even if table was created by a prior partial migration
ALTER TABLE webhook_events
    ADD COLUMN IF NOT EXISTS provider          TEXT    NOT NULL DEFAULT 'razorpay',
    ADD COLUMN IF NOT EXISTS provider_event_id TEXT,
    ADD COLUMN IF NOT EXISTS type              TEXT,
    ADD COLUMN IF NOT EXISTS event_type        TEXT,
    ADD COLUMN IF NOT EXISTS status            TEXT    NOT NULL DEFAULT 'received',
    ADD COLUMN IF NOT EXISTS correlation_id    TEXT,
    ADD COLUMN IF NOT EXISTS error_message     TEXT,
    ADD COLUMN IF NOT EXISTS attempt_count     INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS lease_version     INTEGER,
    ADD COLUMN IF NOT EXISTS lease_expires_at  TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS last_attempt_at   TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS processed_at      TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS razorpay_event_id TEXT,
    ADD COLUMN IF NOT EXISTS updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Back-fill provider_event_id from event_id for Razorpay events
UPDATE webhook_events
SET provider_event_id = event_id
WHERE provider_event_id IS NULL AND event_id IS NOT NULL;

-- Back-fill razorpay_event_id for backward compat
UPDATE webhook_events
SET razorpay_event_id = event_id
WHERE razorpay_event_id IS NULL AND provider = 'razorpay' AND event_id IS NOT NULL;

-- Back-fill event_type from type
UPDATE webhook_events
SET event_type = type
WHERE event_type IS NULL AND type IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. Supporting indexes
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_webhook_events_event_id
    ON webhook_events (event_id);

CREATE INDEX IF NOT EXISTS idx_webhook_events_status_created
    ON webhook_events (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_webhook_events_provider_event_id
    ON webhook_events (provider, provider_event_id);

-- ---------------------------------------------------------------------------
-- 3. refunds table base schema (if not exists)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS refunds (
    id                  BIGSERIAL       PRIMARY KEY,
    payment_id          BIGINT          REFERENCES payments(id),
    booking_id          UUID,
    user_id             UUID,
    razorpay_refund_id  TEXT,
    razorpay_payment_id TEXT,
    amount              NUMERIC(12, 2), -- stored in rupees (historical convention)
    reason              TEXT,
    status              TEXT            NOT NULL DEFAULT 'initiated',
    razorpay_status     TEXT,
    idempotency_key     TEXT,
    processed_by        TEXT,
    last_error          TEXT,
    attempt             INTEGER         NOT NULL DEFAULT 1,
    webhook_event_id    TEXT,
    metadata            JSONB,
    created_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

-- Ensure all columns exist
ALTER TABLE refunds
    ADD COLUMN IF NOT EXISTS razorpay_refund_id  TEXT,
    ADD COLUMN IF NOT EXISTS razorpay_payment_id TEXT,
    ADD COLUMN IF NOT EXISTS idempotency_key     TEXT,
    ADD COLUMN IF NOT EXISTS razorpay_status     TEXT,
    ADD COLUMN IF NOT EXISTS last_error          TEXT,
    ADD COLUMN IF NOT EXISTS attempt             INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS webhook_event_id    TEXT,
    ADD COLUMN IF NOT EXISTS metadata            JSONB,
    ADD COLUMN IF NOT EXISTS updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- ---------------------------------------------------------------------------
-- 4. razorpay_order_mappings table (if not exists)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS razorpay_order_mappings (
    id                  BIGSERIAL       PRIMARY KEY,
    razorpay_order_id   TEXT            NOT NULL,
    booking_id          UUID,
    user_id             UUID,
    amount              NUMERIC(12, 2),
    currency            TEXT            NOT NULL DEFAULT 'INR',
    created_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

ALTER TABLE razorpay_order_mappings
    ADD CONSTRAINT IF NOT EXISTS razorpay_order_mappings_order_id_key
    UNIQUE (razorpay_order_id);

COMMIT;

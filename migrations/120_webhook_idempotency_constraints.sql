-- =============================================================================
-- Migration 120: Webhook Idempotency Constraints + State Machine Hardening
-- =============================================================================
-- Phase 3 of financial hardening plan.
--
-- Problems addressed:
--   1. webhook_events has no UNIQUE constraint on (provider, provider_event_id)
--      → duplicate inserts possible under concurrent webhook delivery
--   2. Webhook states were loosely defined (no DB enforcement)
--      → state machine violations go undetected
--   3. DEAD_LETTER state missing from CHECK constraint
--      → exhausted jobs cannot be marked canonically
--
-- IMPORTANT: Run in a transaction. Review rollback plan before applying to production.
-- PREREQUISITE: migrations/100 and migrations/110 must be applied first.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Ensure webhook_events table exists with correct structure
--    (idempotent — uses IF NOT EXISTS / ADD COLUMN IF NOT EXISTS)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS webhook_events (
    id                  BIGSERIAL       PRIMARY KEY,
    provider            TEXT            NOT NULL DEFAULT 'razorpay',
    provider_event_id   TEXT            NOT NULL,           -- razorpay_event_id or equivalent
    razorpay_event_id   TEXT,                               -- backward compat alias
    event_type          TEXT            NOT NULL,
    payload             JSONB           NOT NULL DEFAULT '{}',
    status              TEXT            NOT NULL DEFAULT 'received',
    correlation_id      TEXT,
    error_message       TEXT,
    attempt_count       INTEGER         NOT NULL DEFAULT 0,
    last_attempt_at     TIMESTAMPTZ,
    processed_at        TIMESTAMPTZ,
    lease_version       INTEGER,
    lease_expires_at    TIMESTAMPTZ,
    created_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- 2. Add columns that may be missing on existing tables (idempotent)
-- ---------------------------------------------------------------------------

ALTER TABLE webhook_events
    ADD COLUMN IF NOT EXISTS provider          TEXT    NOT NULL DEFAULT 'razorpay',
    ADD COLUMN IF NOT EXISTS provider_event_id TEXT,
    ADD COLUMN IF NOT EXISTS status            TEXT    NOT NULL DEFAULT 'received',
    ADD COLUMN IF NOT EXISTS lease_version     INTEGER,
    ADD COLUMN IF NOT EXISTS lease_expires_at  TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS attempt_count     INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS last_attempt_at   TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS processed_at      TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Back-fill provider_event_id from razorpay_event_id for existing rows
UPDATE webhook_events
SET provider_event_id = razorpay_event_id
WHERE provider_event_id IS NULL
  AND razorpay_event_id IS NOT NULL;

-- Make provider_event_id NOT NULL after back-fill
ALTER TABLE webhook_events
    ALTER COLUMN provider_event_id SET NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. State machine: enforce valid states via CHECK constraint
--
--    Canonical webhook event state machine:
--
--      RECEIVED ──► PROCESSING ──► PROCESSED
--                       │
--                       ▼
--                     FAILED ──► DEAD_LETTER
--
--    Transitions:
--      RECEIVED    → PROCESSING  (lease acquired, worker starts)
--      PROCESSING  → PROCESSED   (successfully applied mutation)
--      PROCESSING  → FAILED      (error during processing, will retry)
--      FAILED      → PROCESSING  (retry attempt)
--      FAILED      → DEAD_LETTER (max retries exhausted, needs manual review)
--
--    DEAD_LETTER is terminal. No automated transitions out.
-- ---------------------------------------------------------------------------

-- Drop existing CHECK constraint if any (name varies)
DO $$
DECLARE
    c text;
BEGIN
    SELECT conname INTO c
    FROM pg_constraint
    WHERE conrelid = 'webhook_events'::regclass
      AND contype = 'c'
      AND conname LIKE '%status%'
    LIMIT 1;
    IF c IS NOT NULL THEN
        EXECUTE format('ALTER TABLE webhook_events DROP CONSTRAINT %I', c);
    END IF;
END;
$$;

ALTER TABLE webhook_events
    ADD CONSTRAINT webhook_events_status_check
    CHECK (status IN ('received', 'processing', 'processed', 'failed', 'dead_letter'));

-- Set default to 'received' (correct initial state)
ALTER TABLE webhook_events
    ALTER COLUMN status SET DEFAULT 'received';

-- ---------------------------------------------------------------------------
-- 4. UNIQUE constraint: prevent duplicate processing of the same event
--
--    A single Razorpay event can be delivered multiple times (retry policy).
--    The UNIQUE constraint on (provider, provider_event_id) guarantees:
--      - First INSERT succeeds
--      - Duplicate INSERT raises 23505 (unique_violation) → caught as idempotent
--
--    This is the DB-level guard. The application-level guard is the idempotency
--    check inside the webhook worker (status = 'processed' check).
--    Both must exist: DB constraint catches races; app check provides structured response.
-- ---------------------------------------------------------------------------

-- Drop old unique constraint if it exists under old name
ALTER TABLE webhook_events
    DROP CONSTRAINT IF EXISTS webhook_events_razorpay_event_id_key;

ALTER TABLE webhook_events
    DROP CONSTRAINT IF EXISTS uq_webhook_events_provider_event;

ALTER TABLE webhook_events
    ADD CONSTRAINT uq_webhook_events_provider_event
    UNIQUE (provider, provider_event_id);

-- ---------------------------------------------------------------------------
-- 5. Supporting indexes
-- ---------------------------------------------------------------------------

-- Fast lookup by event status for worker queue polling
CREATE INDEX IF NOT EXISTS idx_webhook_events_status
    ON webhook_events (status)
    WHERE status IN ('received', 'processing', 'failed');

-- Fast lookup for dead-letter review and monitoring
CREATE INDEX IF NOT EXISTS idx_webhook_events_dead_letter
    ON webhook_events (created_at)
    WHERE status = 'dead_letter';

-- Lease expiry index (for lease timeout recovery)
CREATE INDEX IF NOT EXISTS idx_webhook_events_lease_expiry
    ON webhook_events (lease_expires_at)
    WHERE status = 'processing' AND lease_expires_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 6. acquire_webhook_lease() stored procedure
--
--    Atomically transitions an event from 'received'/'failed' → 'processing'
--    and sets a fencing token (lease_version) to prevent stale-write races.
--
--    Returns: (acquired BOOLEAN, lease_version INTEGER)
--      acquired = TRUE  → caller owns the lease and must process
--      acquired = FALSE → another worker holds the lease; skip this event
--
--    The lease_version is a monotonically increasing integer. Each lease
--    acquisition increments it. Workers must fence all DB mutations against
--    this version to prevent stale-owner writes.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION acquire_webhook_lease(
    p_event_id      TEXT,
    p_lease_duration INTERVAL DEFAULT '5 minutes'
)
RETURNS TABLE (acquired BOOLEAN, lease_version INTEGER)
LANGUAGE plpgsql
AS $$
DECLARE
    v_version INTEGER;
BEGIN
    -- Attempt atomic CAS: claim the event if unclaimed or lease expired
    UPDATE webhook_events
    SET
        status           = 'processing',
        lease_version    = COALESCE(lease_version, 0) + 1,
        lease_expires_at = NOW() + p_lease_duration,
        last_attempt_at  = NOW(),
        updated_at       = NOW()
    WHERE
        event_id = p_event_id
        AND (
            status IN ('received', 'failed')
            OR (status = 'processing' AND lease_expires_at < NOW())  -- stale lease takeover
        )
    RETURNING lease_version INTO v_version;

    IF FOUND THEN
        RETURN QUERY SELECT TRUE, v_version;
    ELSE
        RETURN QUERY SELECT FALSE, NULL::INTEGER;
    END IF;
END;
$$;

-- The procedure uses `event_id` column. Ensure it's aliased / exists.
-- If table uses `razorpay_event_id` as PK lookup, add alias:
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'webhook_events' AND column_name = 'event_id'
    ) THEN
        -- Create a generated column aliasing provider_event_id for backward compat
        ALTER TABLE webhook_events
            ADD COLUMN event_id TEXT GENERATED ALWAYS AS (provider_event_id) STORED;
    END IF;
EXCEPTION WHEN OTHERS THEN
    -- If generated column not supported or already exists, use view instead
    NULL;
END;
$$;

-- ---------------------------------------------------------------------------
-- 7. Updated timestamp trigger
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION set_webhook_events_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_webhook_events_updated_at ON webhook_events;

CREATE TRIGGER trg_webhook_events_updated_at
    BEFORE UPDATE ON webhook_events
    FOR EACH ROW
    EXECUTE FUNCTION set_webhook_events_updated_at();

-- ---------------------------------------------------------------------------
-- 8. Mark dead-letter for existing exhausted events
--    Any event that has been in 'failed' state for > 24 hours and has
--    attempt_count >= 5 is considered exhausted.
-- ---------------------------------------------------------------------------

UPDATE webhook_events
SET status = 'dead_letter', updated_at = NOW()
WHERE status = 'failed'
  AND attempt_count >= 5
  AND last_attempt_at < NOW() - INTERVAL '24 hours';

-- ---------------------------------------------------------------------------
-- Commit
-- ---------------------------------------------------------------------------

COMMIT;

-- Post-migration verification (run manually after applying):
-- SELECT status, COUNT(*) FROM webhook_events GROUP BY status;
-- \d+ webhook_events
-- SELECT indexname FROM pg_indexes WHERE tablename = 'webhook_events';

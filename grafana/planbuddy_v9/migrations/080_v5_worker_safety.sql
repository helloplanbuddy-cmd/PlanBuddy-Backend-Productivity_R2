-- ============================================================
-- Migration 080 — PlanBuddy v5.0-A Worker Safe System
-- 🚀 PHASE 2A — Worker Reliability & Failure Safety
-- ============================================================
-- Adds:
--   1. job_state         — tracks every job lifecycle
--   2. dead_letter_jobs  — already exists in v4, extended here
--   3. Indexes for efficient DLQ queries
-- All DDL is idempotent (IF NOT EXISTS / DO NOTHING guards).
-- ============================================================

BEGIN;

-- ─── 1. JOB STATE TABLE ───────────────────────────────────────────────────────
-- Tracks every job from enqueue → processing → success/failed.
-- Used for idempotency checks and full audit trail.

CREATE TABLE IF NOT EXISTS job_state (
  id              UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- Identity
  job_id          VARCHAR(200)  NOT NULL,          -- BullMQ job id or synthetic id
  queue           VARCHAR(100)  NOT NULL,           -- queue name
  job_name        VARCHAR(100)  NOT NULL,           -- job type / name

  -- Lifecycle
  status          VARCHAR(20)   NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'processing', 'success', 'failed', 'dlq')),

  -- Payload (stored for retry / DLQ)
  payload         JSONB         NOT NULL DEFAULT '{}',

  -- Retry tracking
  attempt_count   INT           NOT NULL DEFAULT 0,
  max_attempts    INT           NOT NULL DEFAULT 5,

  -- Error info
  last_error      TEXT,
  error_stack     TEXT,

  -- Timing
  enqueued_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,

  -- Correlation
  correlation_id  VARCHAR(200),
  worker_id       VARCHAR(100)
);

-- Unique job identity per queue (enables idempotency check)
CREATE UNIQUE INDEX IF NOT EXISTS idx_job_state_job_id_queue
  ON job_state (job_id, queue);

-- Fast lookups by status
CREATE INDEX IF NOT EXISTS idx_job_state_status
  ON job_state (status, queue, enqueued_at DESC);

-- Cleanup old completed/success jobs (maintenance worker targets this)
CREATE INDEX IF NOT EXISTS idx_job_state_completed_at
  ON job_state (completed_at)
  WHERE completed_at IS NOT NULL;

COMMENT ON TABLE job_state IS
  'v5.0-A: Full lifecycle tracker for every BullMQ job. '
  'Enables idempotency checks, retry auditing, and DLQ management.';

-- ─── 2. DEAD LETTER JOBS TABLE (extend if exists, create if not) ──────────────
-- v4.0 already had dead_letter_jobs via refund.worker. We extend it to be
-- the universal DLQ for ALL queues.

CREATE TABLE IF NOT EXISTS dead_letter_jobs (
  id              UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- Identity
  queue           VARCHAR(100)  NOT NULL,
  job_name        VARCHAR(100)  NOT NULL,
  job_id          VARCHAR(200),

  -- Payload + failure info
  payload         JSONB         NOT NULL DEFAULT '{}',
  error_message   TEXT,
  error_stack     TEXT,

  -- Retry audit
  retry_count     INT           NOT NULL DEFAULT 0,
  max_retries     INT           NOT NULL DEFAULT 5,

  -- State
  status          VARCHAR(30)   NOT NULL DEFAULT 'exhausted'
                    CHECK (status IN ('exhausted', 'manually_retried', 'resolved', 'ignored')),

  -- Timing
  failed_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  resolved_at     TIMESTAMPTZ,

  -- Who resolved (for admin actions)
  resolved_by     VARCHAR(100),
  resolution_note TEXT
);

-- Prevent duplicate DLQ entries for the same job
CREATE UNIQUE INDEX IF NOT EXISTS idx_dlq_job_id_queue
  ON dead_letter_jobs (job_id, queue)
  WHERE job_id IS NOT NULL;

-- Admin dashboard queries
CREATE INDEX IF NOT EXISTS idx_dlq_status_failed_at
  ON dead_letter_jobs (status, failed_at DESC);

CREATE INDEX IF NOT EXISTS idx_dlq_queue_status
  ON dead_letter_jobs (queue, status);

COMMENT ON TABLE dead_letter_jobs IS
  'v5.0-A: Universal Dead Letter Queue for all worker failures. '
  'Jobs land here after exhausting all retry attempts. '
  'Admin can manually retry or resolve entries.';

-- ─── 3. Add job_id FK to existing tables for cross-reference ─────────────────
ALTER TABLE dead_letter_jobs
  ADD COLUMN IF NOT EXISTS job_state_id UUID REFERENCES job_state(id) ON DELETE SET NULL;

-- ─── 4. Record migration ──────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables WHERE table_name = 'schema_migrations'
  ) THEN
    INSERT INTO schema_migrations (version, description, applied_at)
    VALUES ('080', 'PlanBuddy v5.0-A Worker Safe System — job_state + DLQ', NOW())
    ON CONFLICT (version) DO NOTHING;
  END IF;
END;
$$;

COMMIT;

-- ─── ROLLBACK SCRIPT ─────────────────────────────────────────────────────────
-- BEGIN;
-- DROP TABLE IF EXISTS job_state CASCADE;
-- DROP TABLE IF EXISTS dead_letter_jobs CASCADE;
-- ROLLBACK; -- use COMMIT to apply

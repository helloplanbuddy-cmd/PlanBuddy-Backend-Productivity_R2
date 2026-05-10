-- =============================================================================
-- Migration: 160_payment_audit_retention.sql
-- PlanBuddy V9 — Payment Audit Log Retention & Archival Strategy
-- Author: SRE / Backend Architecture
-- Description: Creates archive table, indexes, safety views, and retention
--              tracking infrastructure for payment_audit_logs.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. ARCHIVE TABLE
--    Mirrors payment_audit_logs exactly + archival metadata columns.
--    Stored on the same cluster; cold-tier tablespace can be assigned later.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS payment_audit_logs_archive (
    -- Core columns — identical to source table
    id                  BIGSERIAL       PRIMARY KEY,
    payment_id          UUID            NOT NULL,
    user_id             UUID            NOT NULL,
    event_type          VARCHAR(100)    NOT NULL,
    event_data          JSONB,
    payment_status      VARCHAR(50)     NOT NULL DEFAULT 'pending',
    refund_status       VARCHAR(50),
    dispute_flag        BOOLEAN         NOT NULL DEFAULT FALSE,
    amount              NUMERIC(15, 4),
    currency            CHAR(3),
    created_at          TIMESTAMPTZ     NOT NULL,
    updated_at          TIMESTAMPTZ,

    -- Archival metadata
    archived_at         TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    archive_batch_id    UUID            NOT NULL,   -- ties row to a specific run
    source_row_id       BIGINT          NOT NULL,   -- original PK from source table

    -- Soft integrity check
    checksum            TEXT            -- SHA-256 of critical fields at archive time
);

COMMENT ON TABLE payment_audit_logs_archive IS
    'Long-term cold store for payment_audit_logs records older than the '
    'retention window. Never delete from this table without explicit legal sign-off.';

-- ---------------------------------------------------------------------------
-- 2. INDEXES — ARCHIVE TABLE
--    Optimise for compliance queries (date range, payment lookup, batch ops)
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_pal_archive_payment_id
    ON payment_audit_logs_archive (payment_id);

CREATE INDEX IF NOT EXISTS idx_pal_archive_created_at
    ON payment_audit_logs_archive (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_pal_archive_archived_at
    ON payment_audit_logs_archive (archived_at DESC);

CREATE INDEX IF NOT EXISTS idx_pal_archive_batch_id
    ON payment_audit_logs_archive (archive_batch_id);

CREATE INDEX IF NOT EXISTS idx_pal_archive_source_row_id
    ON payment_audit_logs_archive (source_row_id);

CREATE INDEX IF NOT EXISTS idx_pal_archive_status
    ON payment_audit_logs_archive (payment_status, refund_status);

CREATE INDEX IF NOT EXISTS idx_pal_archive_dispute
    ON payment_audit_logs_archive (dispute_flag)
    WHERE dispute_flag = TRUE;

-- ---------------------------------------------------------------------------
-- 3. INDEXES — SOURCE TABLE (if not already present)
--    Critical for retention worker batch queries to be fast.
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_pal_created_at
    ON payment_audit_logs (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_pal_payment_id
    ON payment_audit_logs (payment_id);

CREATE INDEX IF NOT EXISTS idx_pal_status_composite
    ON payment_audit_logs (payment_status, refund_status, dispute_flag);

-- Partial index: rows eligible for archival (fast scan for worker)
CREATE INDEX IF NOT EXISTS idx_pal_archivable
    ON payment_audit_logs (created_at)
    WHERE
        payment_status  = 'completed'
    AND (refund_status  = 'settled' OR refund_status IS NULL)
    AND dispute_flag    = FALSE;

-- ---------------------------------------------------------------------------
-- 4. RETENTION JOB TRACKING TABLE
--    Idempotency guard + audit trail for every retention run.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS retention_job_runs (
    id                  BIGSERIAL       PRIMARY KEY,
    batch_id            UUID            NOT NULL UNIQUE DEFAULT gen_random_uuid(),
    job_name            VARCHAR(100)    NOT NULL,
    started_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    completed_at        TIMESTAMPTZ,
    status              VARCHAR(20)     NOT NULL DEFAULT 'running'
                            CHECK (status IN ('running','completed','failed','partial')),
    rows_scanned        BIGINT          NOT NULL DEFAULT 0,
    rows_archived       BIGINT          NOT NULL DEFAULT 0,
    rows_skipped        BIGINT          NOT NULL DEFAULT 0,
    error_message       TEXT,
    metadata            JSONB           NOT NULL DEFAULT '{}'::JSONB
);

COMMENT ON TABLE retention_job_runs IS
    'Audit trail for every execution of the payment-audit retention worker. '
    'Used for idempotency checks and operational dashboards.';

CREATE INDEX IF NOT EXISTS idx_rjr_job_name_started
    ON retention_job_runs (job_name, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_rjr_status
    ON retention_job_runs (status)
    WHERE status IN ('running', 'failed');

-- ---------------------------------------------------------------------------
-- 5. SAFETY VIEW — ROWS CURRENTLY LOCKED FROM ARCHIVAL
--    Useful for operational queries; referenced by worker logic.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW v_payment_audit_logs_locked AS
SELECT
    id,
    payment_id,
    payment_status,
    refund_status,
    dispute_flag,
    created_at,
    CASE
        WHEN payment_status  != 'completed'             THEN 'payment_not_completed'
        WHEN refund_status NOT IN ('settled', 'none')
             AND refund_status IS NOT NULL               THEN 'refund_pending'
        WHEN dispute_flag = TRUE                        THEN 'active_dispute'
        ELSE 'unknown'
    END AS lock_reason
FROM payment_audit_logs
WHERE
    payment_status  != 'completed'
    OR (refund_status NOT IN ('settled', 'none') AND refund_status IS NOT NULL)
    OR dispute_flag = TRUE;

COMMENT ON VIEW v_payment_audit_logs_locked IS
    'Live view of all payment_audit_logs rows that cannot be archived right now.';

-- ---------------------------------------------------------------------------
-- 6. HELPER FUNCTION — ELIGIBILITY CHECK (callable from application layer)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION is_audit_log_archivable(
    p_id            BIGINT,
    p_retention_days INT DEFAULT 90
)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    v_row payment_audit_logs%ROWTYPE;
BEGIN
    SELECT * INTO v_row
    FROM payment_audit_logs
    WHERE id = p_id;

    IF NOT FOUND THEN
        RETURN FALSE;  -- already gone
    END IF;

    RETURN (
        v_row.created_at      < NOW() - (p_retention_days || ' days')::INTERVAL
        AND v_row.payment_status  = 'completed'
        AND (v_row.refund_status  = 'settled' OR v_row.refund_status IS NULL OR v_row.refund_status = 'none')
        AND v_row.dispute_flag    = FALSE
    );
END;
$$;

-- ---------------------------------------------------------------------------
-- 7. GRANT PRIVILEGES (adjust role names to match your environment)
-- ---------------------------------------------------------------------------

-- Read-only role can query archive
-- GRANT SELECT ON payment_audit_logs_archive TO planbuddy_readonly;
-- GRANT SELECT ON v_payment_audit_logs_locked  TO planbuddy_readonly;

-- Worker role needs insert on archive + delete on source + update on job runs
-- GRANT SELECT, INSERT ON payment_audit_logs_archive TO planbuddy_worker;
-- GRANT DELETE         ON payment_audit_logs          TO planbuddy_worker;
-- GRANT SELECT, INSERT, UPDATE ON retention_job_runs  TO planbuddy_worker;

COMMIT;

-- =============================================================================
-- ROLLBACK SCRIPT (keep alongside this file as 160_payment_audit_retention.rollback.sql)
-- =============================================================================
-- BEGIN;
-- DROP VIEW  IF EXISTS v_payment_audit_logs_locked;
-- DROP FUNCTION IF EXISTS is_audit_log_archivable(BIGINT, INT);
-- DROP TABLE IF EXISTS retention_job_runs;
-- DROP TABLE IF EXISTS payment_audit_logs_archive;
-- DROP INDEX IF EXISTS idx_pal_created_at;
-- DROP INDEX IF EXISTS idx_pal_payment_id;
-- DROP INDEX IF EXISTS idx_pal_status_composite;
-- DROP INDEX IF EXISTS idx_pal_archivable;
-- COMMIT;

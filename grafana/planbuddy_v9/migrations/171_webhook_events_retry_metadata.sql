-- Migration: 171_webhook_events_retry_metadata.sql
-- Adds failure tracking columns to webhook_events for observability and replay

BEGIN;

-- Add columns for failure metadata and retry tracking
ALTER TABLE webhook_events
ADD COLUMN IF NOT EXISTS error_message TEXT,
ADD COLUMN IF NOT EXISTS attempt_count INT NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMPTZ;

-- Create index for efficient replay queries
CREATE INDEX IF NOT EXISTS idx_webhook_events_failed_retry
ON webhook_events (status, attempt_count, last_attempt_at)
WHERE status = 'failed';

-- Create index for events pending retry (max 5 attempts)
CREATE INDEX IF NOT EXISTS idx_webhook_events_retry_candidates
ON webhook_events (last_attempt_at ASC)
WHERE status = 'failed' AND attempt_count < 5;

COMMIT;

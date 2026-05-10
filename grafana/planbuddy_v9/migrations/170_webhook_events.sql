-- ============================================================================
-- Migration 170: webhook_events table (exactly-once webhook persistence)
-- ============================================================================

BEGIN;

-- Create table if it doesn't exist. Existing deployments may already have
-- webhook_events from partial experiments; make this idempotent.
CREATE TABLE IF NOT EXISTS webhook_events (
  id                  UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  provider            VARCHAR(20) NOT NULL DEFAULT 'razorpay',
  event_id            VARCHAR(200) NOT NULL,
  type                VARCHAR(200),
  payload             JSONB,
  status              TEXT NOT NULL CHECK (status IN ('pending','processed','failed')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at        TIMESTAMPTZ
);

-- Exactly-once guarantee: provider+event_id uniqueness.
-- Razorpay event ids are globally unique in practice, but we enforce by event_id.
ALTER TABLE webhook_events
  ADD CONSTRAINT webhook_events_event_id_unique
  UNIQUE (event_id)
  DEFERRABLE INITIALLY IMMEDIATE;

-- Indexes for lookups.
CREATE INDEX IF NOT EXISTS idx_webhook_events_event_id ON webhook_events(event_id);
CREATE INDEX IF NOT EXISTS idx_webhook_events_created_at ON webhook_events(created_at);
CREATE INDEX IF NOT EXISTS idx_webhook_events_status ON webhook_events(status);

-- Migration tracking.
INSERT INTO schema_migrations (version, filename, run_at)
VALUES ('170', '170_webhook_events.sql', NOW())
ON CONFLICT (version) DO NOTHING;

COMMIT;


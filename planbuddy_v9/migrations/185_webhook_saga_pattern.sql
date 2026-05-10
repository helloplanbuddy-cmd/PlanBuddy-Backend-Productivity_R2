-- Migration: Add saga pattern support for webhook processing
BEGIN;

-- Table to track each processing step
CREATE TABLE webhook_processing_steps (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  event_id UUID NOT NULL REFERENCES webhook_events(event_id),
  step_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'compensated', 'failed')),
  payload JSONB,
  executed_at TIMESTAMPTZ,
  compensated_at TIMESTAMPTZ,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_webhook_steps_event ON webhook_processing_steps(event_id, step_name);
CREATE INDEX idx_webhook_steps_recovery ON webhook_processing_steps(event_id, status);

-- Function to recover interrupted transactions
CREATE OR REPLACE FUNCTION recover_webhook_transactions() RETURNS INTEGER AS $$
DECLARE
  v_count INTEGER;
BEGIN
  WITH events_to_recover AS (
    SELECT event_id 
    FROM webhook_events
    WHERE status = 'processing'
      AND processing_timeout < NOW()
      AND attempt_count < 5
    FOR UPDATE SKIP LOCKED
    LIMIT 100
  ),
  recovery_steps AS (
    UPDATE webhook_processing_steps s
    SET status = 'compensated',
        compensated_at = NOW(),
        updated_at = NOW()
    FROM events_to_recover e
    WHERE s.event_id = e.event_id
      AND s.status = 'completed'
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_count FROM recovery_steps;
  
  -- Reset the event status
  UPDATE webhook_events e
  SET status = 'pending',
      processing_timeout = NULL,
      lease_id = NULL,
      lease_expires_at = NULL
  FROM events_to_recover r
  WHERE e.event_id = r.event_id;
  
  RETURN v_count;
END;
$$ LANGUAGE plpgsql;

-- Function to process DLQ items
CREATE OR REPLACE FUNCTION process_dlq_webhooks() RETURNS INTEGER AS $$
DECLARE
  v_count INTEGER;
BEGIN
  WITH dlq_events AS (
    SELECT event_id
    FROM webhook_events
    WHERE status = 'failed'
      AND attempt_count >= 5
    FOR UPDATE SKIP LOCKED
    LIMIT 100
  ),
  compensated AS (
    UPDATE webhook_processing_steps s
    SET status = 'compensated',
        compensated_at = NOW(),
        updated_at = NOW()
    FROM dlq_events d
    WHERE s.event_id = d.event_id
      AND s.status = 'completed'
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_count FROM compensated;
  
  -- Mark events as requiring manual review
  UPDATE webhook_events e
  SET status = 'requires_manual_review'
  FROM dlq_events d
  WHERE e.event_id = d.event_id;
  
  RETURN v_count;
END;
$$ LANGUAGE plpgsql;

-- Add manual review status
ALTER TYPE webhook_status ADD VALUE 'requires_manual_review';

COMMIT;

-- Migration: Add webhook processing safety features
BEGIN;

-- Add processing timeout and lease columns
ALTER TABLE webhook_events
ADD COLUMN processing_timeout TIMESTAMPTZ,
ADD COLUMN lease_id UUID,
ADD COLUMN lease_expires_at TIMESTAMPTZ,
ADD COLUMN lease_version BIGINT NOT NULL DEFAULT 0;

-- Index for stuck job recovery
CREATE INDEX idx_webhook_events_stuck_jobs ON webhook_events (lease_expires_at)
WHERE status = 'processing' AND lease_expires_at IS NOT NULL;

-- Function to acquire lease (atomic ownership transfer)
-- Reclaim semantics:
-- - Allows acquiring when row is pending
-- - AND allows reclaim when status='processing' but lease is expired
-- - Also allows reclaim when status='failed' (optional: safe because processing is idempotent)
CREATE OR REPLACE FUNCTION acquire_webhook_lease(
  p_event_id UUID,
  p_lease_duration INTERVAL DEFAULT '5 minutes'
) RETURNS TABLE(acquired BOOLEAN, lease_version BIGINT) AS $$
DECLARE
  v_lease_version BIGINT;
BEGIN
  UPDATE webhook_events
  SET lease_id = gen_random_uuid(),
      lease_expires_at = NOW() + p_lease_duration,
      processing_timeout = NOW() + p_lease_duration,
      lease_version = lease_version + 1,
      status = 'processing'
  WHERE event_id = p_event_id
    AND (
      -- fresh ownership
      status = 'pending'
      -- reclaim expired ownership
      OR (
        status = 'processing'
        AND (lease_expires_at IS NULL OR lease_expires_at < NOW())
      )
      -- allow reclaim from failed as well
      OR (
        status = 'failed'
        AND (lease_expires_at IS NULL OR lease_expires_at < NOW())
      )
    )
  RETURNING lease_version INTO v_lease_version;

  IF v_lease_version IS NULL THEN
    RETURN QUERY SELECT FALSE AS acquired, NULL::BIGINT AS lease_version;
  END IF;

  RETURN QUERY SELECT TRUE AS acquired, v_lease_version AS lease_version;
END;
$$ LANGUAGE plpgsql;


-- Function for stuck job recovery
CREATE OR REPLACE FUNCTION release_stuck_webhooks() RETURNS INTEGER AS $$
DECLARE
  v_count INTEGER;
BEGIN
  WITH updated AS (
    UPDATE webhook_events
    SET status = 'pending',
        lease_id = NULL,
        lease_expires_at = NULL,
        processing_timeout = NULL,
        attempt_count = attempt_count + 1
    WHERE status = 'processing'
      AND processing_timeout < NOW()
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_count FROM updated;
  
  RETURN v_count;
END;
$$ LANGUAGE plpgsql;

COMMIT;
</fitten_content>

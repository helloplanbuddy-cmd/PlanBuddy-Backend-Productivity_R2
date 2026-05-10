-- ============================================================================
-- Migration 186: financial_transition_ledger (append-only forensic ledger)
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS financial_transition_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type            VARCHAR(30) NOT NULL,
  entity_id              UUID NOT NULL,

  previous_state         VARCHAR(50),
  next_state             VARCHAR(50),

  reason                 TEXT,
  source_domain          TEXT NOT NULL,

  correlation_id         VARCHAR(200),
  webhook_event_id      VARCHAR(200),

  lease_version          BIGINT,

  idempotency_key        VARCHAR(255),

  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fin_ledger_entity
  ON financial_transition_ledger(entity_type, entity_id);

CREATE INDEX IF NOT EXISTS idx_fin_ledger_correlation
  ON financial_transition_ledger(correlation_id);

CREATE INDEX IF NOT EXISTS idx_fin_ledger_webhook
  ON financial_transition_ledger(webhook_event_id);

-- Ensure append-only: block updates/deletes at DB level.
-- (We keep it simple: deny UPDATE/DELETE by trigger.)
CREATE OR REPLACE FUNCTION prevent_fin_ledger_updates()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'financial_transition_ledger is append-only (UPDATE/DELETE blocked)';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_fin_ledger_no_update ON financial_transition_ledger;
CREATE TRIGGER trg_fin_ledger_no_update
BEFORE UPDATE OR DELETE ON financial_transition_ledger
FOR EACH ROW EXECUTE FUNCTION prevent_fin_ledger_updates();

INSERT INTO schema_migrations (version, filename, run_at)
VALUES ('186', '186_financial_transition_ledger.sql', NOW())
ON CONFLICT (version) DO NOTHING;

COMMIT;

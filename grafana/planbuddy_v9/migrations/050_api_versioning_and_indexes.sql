-- =============================================================================
-- Migration 050: Production 2.0 — Performance Indexes & Housekeeping
-- Run after: 040_missing_production_tables.sql
-- =============================================================================

BEGIN;

-- ─── Composite indexes for common query patterns ───────────────────────────────

-- Booking list query (user's bookings by status + date)
CREATE INDEX IF NOT EXISTS idx_bookings_user_status_date
  ON bookings(user_id, status, created_at DESC);

-- Payment lookup by order (reconciliation worker)
CREATE INDEX IF NOT EXISTS idx_payments_razorpay_order_id
  ON payments(razorpay_order_id)
  WHERE razorpay_order_id IS NOT NULL;

-- Token blacklist: fast JTI lookup
CREATE INDEX IF NOT EXISTS idx_token_blacklist_jti_expires
  ON token_blacklist(jti, expires_at)
  WHERE expires_at > NOW();

-- Audit log: recent events by action type (admin dashboard)
CREATE INDEX IF NOT EXISTS idx_audit_log_action_created
  ON audit_log(action, created_at DESC);

-- ─── Partial index: pending bookings past expiry (expiry worker) ───────────────
CREATE INDEX IF NOT EXISTS idx_bookings_expired_pending
  ON bookings(expires_at)
  WHERE status = 'pending' AND payment_status = 'unpaid';

-- ─── trips: full-text search on title (search endpoint) ───────────────────────
CREATE INDEX IF NOT EXISTS idx_trips_title_fts
  ON trips USING gin(to_tsvector('english', title));

-- ─── payments: user + status (user payment history) ───────────────────────────
CREATE INDEX IF NOT EXISTS idx_payments_user_status
  ON payments(user_id, status, created_at DESC);

-- ─── rate_limit_hits: cleanup by reset_at (already in 030, safety guard) ──────
CREATE INDEX IF NOT EXISTS idx_rate_limit_hits_reset_at
  ON rate_limit_hits(reset_at);

-- Track migration
INSERT INTO schema_migrations (version, filename)
VALUES ('050', '050_api_versioning_and_indexes.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;

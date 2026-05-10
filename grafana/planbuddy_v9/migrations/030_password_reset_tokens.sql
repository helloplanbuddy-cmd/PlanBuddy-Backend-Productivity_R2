-- migrations/030_password_reset_tokens.sql
-- Run after: 020_production_safety_fixes.sql
-- Purpose: Password reset OTP flow + user active flag

-- ─── password_reset_tokens table ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  -- Primary key is user_id: one active token per user at a time.
  -- ON CONFLICT (user_id) DO UPDATE replaces the token on re-request.
  user_id    UUID         NOT NULL PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,

  -- bcrypt hash of the raw 6-digit OTP. Never store the raw OTP.
  -- Length 60 is the fixed output length of bcrypt.
  token_hash VARCHAR(60)  NOT NULL,

  -- Token validity window (15 minutes from creation)
  expires_at TIMESTAMPTZ  NOT NULL,

  -- Track brute-force attempts. Invalidate after 5 wrong guesses.
  attempts   INTEGER      NOT NULL DEFAULT 0,

  created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Index to quickly purge expired tokens in a maintenance job
CREATE INDEX IF NOT EXISTS idx_prt_expires_at
  ON password_reset_tokens (expires_at);

-- ─── users table additions ────────────────────────────────────────────────────

-- Soft-delete flag: deactivated users cannot log in or request resets.
-- Default true so all existing users are unaffected.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;

-- Partial index: only indexes active users — smaller index, faster auth lookups
CREATE INDEX IF NOT EXISTS idx_users_active
  ON users (id)
  WHERE is_active = true;

-- ─── rate_limit_hits table (for PgRateLimitStore) ────────────────────────────
-- Created here so the store can be used from first boot without a separate migration.

CREATE TABLE IF NOT EXISTS rate_limit_hits (
  key        VARCHAR(200) PRIMARY KEY,
  hits       INTEGER      NOT NULL DEFAULT 1,
  reset_at   TIMESTAMPTZ  NOT NULL,
  updated_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- TTL cleanup index: allows efficient deletion of expired rows
CREATE INDEX IF NOT EXISTS idx_rlh_reset_at
  ON rate_limit_hits (reset_at);

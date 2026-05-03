-- ============================================================================
-- PlanBuddy.in — Complete Initial Database Schema
-- ============================================================================
-- Run: psql $DATABASE_URL -f migrations/000_initial_schema.sql
-- All tables are idempotent (CREATE TABLE IF NOT EXISTS)
-- ============================================================================

BEGIN;

-- Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_stat_statements";

-- Schema migration tracking
CREATE TABLE IF NOT EXISTS schema_migrations (
  version   VARCHAR(20)  PRIMARY KEY,
  filename  VARCHAR(200) NOT NULL,
  run_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ─── USERS ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id            UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  email         VARCHAR(254) NOT NULL UNIQUE,
  password_hash VARCHAR(72)  NOT NULL,
  name          VARCHAR(200) NOT NULL,
  phone         VARCHAR(20),
  role          VARCHAR(20)  NOT NULL DEFAULT 'user'
                             CHECK (role IN ('user', 'agency', 'admin')),
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_users_email  ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_role   ON users(role);

-- ─── TRIPS ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS trips (
  id              UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  agency_id       UUID          NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  title           VARCHAR(200)  NOT NULL,
  description     TEXT          NOT NULL,
  location        VARCHAR(200)  NOT NULL,
  price           NUMERIC(12,2) NOT NULL CHECK (price > 0),
  currency        CHAR(3)       NOT NULL DEFAULT 'INR',
  max_group_size  INTEGER       NOT NULL CHECK (max_group_size > 0),
  current_bookings INTEGER      NOT NULL DEFAULT 0 CHECK (current_bookings >= 0),
  start_date      DATE,
  end_date        DATE,
  duration_days   INTEGER,
  cover_image     TEXT,
  itinerary       JSONB         NOT NULL DEFAULT '[]',
  tags            JSONB         NOT NULL DEFAULT '[]',
  category        VARCHAR(50)   NOT NULL DEFAULT 'other',
  is_active       BOOLEAN       NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ,

  CONSTRAINT trips_capacity_check CHECK (current_bookings <= max_group_size)
);

CREATE INDEX IF NOT EXISTS idx_trips_agency_id ON trips(agency_id);
CREATE INDEX IF NOT EXISTS idx_trips_active     ON trips(id) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_trips_location   ON trips USING gin(to_tsvector('english', location));
CREATE INDEX IF NOT EXISTS idx_trips_category   ON trips(category) WHERE is_active = true;

-- ─── BOOKINGS ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bookings (
  id                       UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id                  UUID          NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  agency_id                UUID          NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  trip_id                  UUID          NOT NULL REFERENCES trips(id) ON DELETE RESTRICT,
  trip_snapshot            JSONB         NOT NULL DEFAULT '{}',
  group_size               INTEGER       NOT NULL CHECK (group_size > 0),
  total_amount             NUMERIC(12,2) NOT NULL,
  final_amount             NUMERIC(12,2) NOT NULL,
  travel_date              DATE          NOT NULL,
  status                   VARCHAR(20)   NOT NULL DEFAULT 'pending'
                                         CHECK (status IN ('pending', 'confirmed', 'cancelled', 'completed')),
  payment_status           VARCHAR(20)   NOT NULL DEFAULT 'unpaid'
                                         CHECK (payment_status IN ('unpaid', 'paid', 'refunded', 'partially_refunded')),
  idempotency_key          VARCHAR(200)  UNIQUE,
  razorpay_order_id        VARCHAR(100),
  razorpay_payment_id      VARCHAR(100),
  cancellation_reason      VARCHAR(500),
  cancelled_at             TIMESTAMPTZ,
  expires_at               TIMESTAMPTZ,
  stripe_payment_intent_id VARCHAR(200), -- kept for forward compatibility
  stripe_charge_id         VARCHAR(200),
  created_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ
);

-- Prevent duplicate active booking for same user/trip/date
CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_no_dup_active
  ON bookings(user_id, trip_id, travel_date)
  WHERE status != 'cancelled';

CREATE INDEX IF NOT EXISTS idx_bookings_user_id       ON bookings(user_id);
CREATE INDEX IF NOT EXISTS idx_bookings_trip_id       ON bookings(trip_id);
CREATE INDEX IF NOT EXISTS idx_bookings_status        ON bookings(status);
CREATE INDEX IF NOT EXISTS idx_bookings_expires_at    ON bookings(expires_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_bookings_razorpay_order ON bookings(razorpay_order_id) WHERE razorpay_order_id IS NOT NULL;

-- ─── PAYMENTS ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payments (
  id                   UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  booking_id           UUID          NOT NULL REFERENCES bookings(id) ON DELETE RESTRICT,
  user_id              UUID          NOT NULL REFERENCES users(id)    ON DELETE RESTRICT,
  provider             VARCHAR(20)   NOT NULL DEFAULT 'razorpay',
  razorpay_payment_id  VARCHAR(100),
  razorpay_order_id    VARCHAR(100),
  amount               NUMERIC(12,2) NOT NULL,
  currency             CHAR(3)       NOT NULL DEFAULT 'INR',
  status               VARCHAR(20)   NOT NULL DEFAULT 'created'
                                     CHECK (status IN ('created', 'captured', 'failed', 'refunded')),
  refund_id            VARCHAR(100),
  refunded_at          TIMESTAMPTZ,
  created_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_razorpay_payment_id
  ON payments(razorpay_payment_id)
  WHERE razorpay_payment_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_payments_booking_id ON payments(booking_id);
CREATE INDEX IF NOT EXISTS idx_payments_user_id    ON payments(user_id);
CREATE INDEX IF NOT EXISTS idx_payments_status     ON payments(status);

-- ─── RAZORPAY ORDER MAPPINGS ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS razorpay_order_mappings (
  razorpay_order_id  VARCHAR(100) PRIMARY KEY,
  booking_id         UUID         NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  user_id            UUID         NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  amount             NUMERIC(12,2) NOT NULL,
  currency           CHAR(3)      NOT NULL DEFAULT 'INR',
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_razorpay_order_mappings_booking
  ON razorpay_order_mappings(booking_id);

-- ─── WEBHOOK EVENTS ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS webhook_events (
  id                  UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  provider            VARCHAR(20) NOT NULL DEFAULT 'razorpay',
  razorpay_event_id   VARCHAR(200) UNIQUE,
  event_type          VARCHAR(100),
  payload             TEXT,
  correlation_id      VARCHAR(100),
  processed_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_webhook_events_razorpay_event_id ON webhook_events(razorpay_event_id);
CREATE INDEX IF NOT EXISTS idx_webhook_events_created_at        ON webhook_events(created_at);

-- ─── IDEMPOTENCY KEYS ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key            VARCHAR(200) PRIMARY KEY,
  user_id        UUID         REFERENCES users(id) ON DELETE CASCADE,
  request_path   VARCHAR(500),
  request_hash   VARCHAR(64),
  response_code  SMALLINT,
  response_body  JSONB,
  expires_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW() + INTERVAL '24 hours',
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_idempotency_keys_expires_at ON idempotency_keys(expires_at);

-- ─── RECONCILIATION LOG ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reconciliation_log (
  id             UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  payment_id     UUID         REFERENCES payments(id),
  booking_id     UUID         REFERENCES bookings(id),
  action         VARCHAR(50),
  status         VARCHAR(20),
  correlation_id VARCHAR(100),
  notes          TEXT,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reconciliation_log_created_at ON reconciliation_log(created_at);

-- ─── Track initial migration ───────────────────────────────────────────────────
INSERT INTO schema_migrations (version, filename)
VALUES ('000', '000_initial_schema.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;

-- SISO booking module — Cloudflare D1 schema.
-- Dates are canonical UTC ISO strings with a trailing Z. Do not write local
-- datetimes into these columns; the overlap guard depends on fixed-width text
-- ordering.

CREATE TABLE IF NOT EXISTS booking_bookings (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  service_id TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  blocked_starts_at TEXT NOT NULL,
  blocked_ends_at TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  customer_email TEXT NOT NULL,
  customer_phone TEXT,
  customer_notes TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'awaiting_payment', 'confirmed', 'cancelled', 'expired')),
  payment_status TEXT CHECK (payment_status IS NULL OR payment_status IN ('unpaid', 'pending', 'paid', 'failed', 'refunded')),
  payment_amount_cents INTEGER NOT NULL DEFAULT 0 CHECK (payment_amount_cents >= 0),
  currency TEXT NOT NULL DEFAULT 'gbp',
  idempotency_key TEXT NOT NULL,
  manage_token_hash TEXT NOT NULL,
  stripe_session_id TEXT UNIQUE,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS booking_idempotency_idx
  ON booking_bookings(provider_id, idempotency_key);

CREATE INDEX IF NOT EXISTS booking_provider_time_idx
  ON booking_bookings(provider_id, starts_at, ends_at);

CREATE INDEX IF NOT EXISTS booking_status_expiry_idx
  ON booking_bookings(status, expires_at);

CREATE INDEX IF NOT EXISTS booking_customer_email_idx
  ON booking_bookings(customer_email);

-- One operator override per local calendar date. A closed row has no times;
-- an hours row replaces the weekly window for that date.
CREATE TABLE IF NOT EXISTS booking_availability_overrides (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  local_date TEXT NOT NULL,
  start_time TEXT,
  end_time TEXT,
  unavailable INTEGER NOT NULL DEFAULT 0 CHECK (unavailable IN (0, 1)),
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (unavailable = 1 AND start_time IS NULL AND end_time IS NULL)
    OR (unavailable = 0 AND start_time IS NOT NULL AND end_time IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS booking_override_date_idx
  ON booking_availability_overrides(provider_id, local_date);

CREATE INDEX IF NOT EXISTS booking_override_range_idx
  ON booking_availability_overrides(provider_id, local_date, unavailable);

CREATE TABLE IF NOT EXISTS booking_webhook_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  received_at TEXT NOT NULL
);

-- Schéma docházkového CRM (PostgreSQL). Idempotentní – spouští se při každém startu.

CREATE TABLE IF NOT EXISTS employees (
    id          SERIAL PRIMARY KEY,
    name        TEXT NOT NULL,
    phone       TEXT,
    pin_code    TEXT NOT NULL UNIQUE,
    active      BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sites (
    id           SERIAL PRIMARY KEY,
    name         TEXT NOT NULL,
    address      TEXT,
    phone_number TEXT UNIQUE
);

CREATE TABLE IF NOT EXISTS attendance_logs (
    id              BIGSERIAL PRIMARY KEY,
    employee_id     INTEGER NOT NULL REFERENCES employees(id),
    site_id         INTEGER REFERENCES sites(id),
    event_type      TEXT NOT NULL CHECK (event_type IN ('check_in', 'check_out')),
    called_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    caller_number   TEXT,
    caller_verified BOOLEAN NOT NULL DEFAULT FALSE,
    call_sid        TEXT
);

CREATE INDEX IF NOT EXISTS idx_logs_employee_time ON attendance_logs (employee_id, called_at DESC);
CREATE INDEX IF NOT EXISTS idx_logs_site_time     ON attendance_logs (site_id, called_at DESC);
CREATE INDEX IF NOT EXISTS idx_logs_called_at     ON attendance_logs (called_at DESC);

-- Plánované směny – pro hlídání nenahlášených příchodů
CREATE TABLE IF NOT EXISTS shifts (
    id           SERIAL PRIMARY KEY,
    employee_id  INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    site_id      INTEGER REFERENCES sites(id) ON DELETE SET NULL,
    starts_at    TIMESTAMPTZ NOT NULL,
    grace_min    INTEGER NOT NULL DEFAULT 15,
    alerted      BOOLEAN NOT NULL DEFAULT FALSE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_shifts_starts ON shifts (starts_at);

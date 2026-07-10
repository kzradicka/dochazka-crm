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

-- Telefonní čísla přiřazená k objektu. Číslo, ze kterého se volá, určuje objekt.
-- Jedno číslo patří právě jednomu objektu (UNIQUE).
CREATE TABLE IF NOT EXISTS site_phones (
    id           SERIAL PRIMARY KEY,
    site_id      INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    phone_number TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_site_phones_number ON site_phones (phone_number);

-- Počet hodin u záznamu docházky (pro mzdy). Výchozí 12, lze ručně upravit.
ALTER TABLE attendance_logs ADD COLUMN IF NOT EXISTS hours NUMERIC NOT NULL DEFAULT 12;

-- Délka směny zaměstnance v hodinách (1–12). Určuje výchozí hodiny záznamu i automatické odhlášení.
ALTER TABLE employees ADD COLUMN IF NOT EXISTS shift_hours INTEGER NOT NULL DEFAULT 12;

-- ============================================================
-- Hlídání příchodů per pobočka (nový systém)
-- ============================================================

-- Očekávané časy příchodu na pobočku. Ke každé pobočce libovolný počet časů.
-- dow = dny v týdnu, kdy čas platí (řetězec číslic 1=Po … 7=Ne, např. '12345').
CREATE TABLE IF NOT EXISTS site_schedules (
    id               SERIAL PRIMARY KEY,
    site_id          INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    expected_time    TIME NOT NULL,
    dow              TEXT NOT NULL DEFAULT '1234567',
    first_alert_min  INTEGER NOT NULL DEFAULT 15,
    second_alert_min INTEGER NOT NULL DEFAULT 30,
    active           BOOLEAN NOT NULL DEFAULT TRUE,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_site_schedules_site ON site_schedules (site_id);

-- Kontaktní čísla pro druhou eskalaci (+30 min). Ručně přidávaná, oddělená od čísel,
-- ze kterých se na pobočce hlásí.
CREATE TABLE IF NOT EXISTS site_contacts (
    id           SERIAL PRIMARY KEY,
    site_id      INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    phone_number TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_site_contacts_site ON site_contacts (site_id);

-- Evidence odeslaných upozornění, aby se neposílala opakovaně.
-- level 1 = hovor na pobočku (+10 min), level 2 = hovor na kontakty (+15 min).
CREATE TABLE IF NOT EXISTS schedule_alerts (
    id          BIGSERIAL PRIMARY KEY,
    schedule_id INTEGER NOT NULL REFERENCES site_schedules(id) ON DELETE CASCADE,
    alert_date  DATE NOT NULL,
    level       SMALLINT NOT NULL,
    sent_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (schedule_id, alert_date, level)
);

-- ============================================================
-- Odhlašování na vybraných objektech (jen kde requires_checkout = TRUE)
-- ============================================================

-- Příznak, že se na objektu musí zaměstnanec i odhlásit (IVR nabídne 1=přihlášení, 2=odhlášení).
-- Ostatní objekty (FALSE) fungují beze změny – jen přihlášení.
ALTER TABLE sites ADD COLUMN IF NOT EXISTS requires_checkout BOOLEAN NOT NULL DEFAULT FALSE;

-- Očekávaný čas odhlášení pro daný check_in (naplánovaný začátek + délka směny).
-- Vyplní se při přihlášení na objektu s requires_checkout; jinak zůstává NULL.
ALTER TABLE attendance_logs ADD COLUMN IF NOT EXISTS expected_checkout TIMESTAMPTZ;

-- Evidence odeslaných upozornění na CHYBĚJÍCÍ odhlášení (aby se neopakovala).
-- check_in_id = záznam přihlášení, level 1 = hovor na objekt (+10 min), level 2 = kontakty (+15 min).
CREATE TABLE IF NOT EXISTS checkout_alerts (
    id          BIGSERIAL PRIMARY KEY,
    check_in_id BIGINT NOT NULL REFERENCES attendance_logs(id) ON DELETE CASCADE,
    level       SMALLINT NOT NULL,
    sent_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (check_in_id, level)
);
CREATE INDEX IF NOT EXISTS idx_checkout_alerts_checkin ON checkout_alerts (check_in_id);

-- ============================================================
-- Očekávané ODCHODY (jen objekty s requires_checkout) – zrcadlo příchodů.
-- Čas + dny, kdy se má provést odhlášení. Dříve se odhlásit nelze,
-- +10 min po čase → hovor na objekt (level 1), +15 min → kontakty (level 2).
-- ============================================================
CREATE TABLE IF NOT EXISTS site_checkout_schedules (
    id            SERIAL PRIMARY KEY,
    site_id       INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    expected_time TIME NOT NULL,
    dow           TEXT NOT NULL DEFAULT '1234567',
    active        BOOLEAN NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_site_checkout_sched_site ON site_checkout_schedules (site_id);

-- Evidence upozornění na chybějící odhlášení (aby se neopakovala).
CREATE TABLE IF NOT EXISTS checkout_schedule_alerts (
    id                    BIGSERIAL PRIMARY KEY,
    checkout_schedule_id  INTEGER NOT NULL REFERENCES site_checkout_schedules(id) ON DELETE CASCADE,
    alert_date            DATE NOT NULL,
    level                 SMALLINT NOT NULL,
    sent_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (checkout_schedule_id, alert_date, level)
);

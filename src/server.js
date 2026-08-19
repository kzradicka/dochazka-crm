import express from 'express';
import twilio from 'twilio';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';

import pool, { migrate } from './db.js';
import { login, requireAuth } from './auth.js';
import { startShiftWatcher } from './notifications.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const VoiceResponse = twilio.twiml.VoiceResponse;

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const SAY = { voice: 'Google.cs-CZ-Standard-A', language: 'cs-CZ' };
const MAX_ATTEMPTS = 3;
// Po této době se přihlášený zaměstnanec automaticky považuje za odhlášeného (zmizí z přehledu).
const SHIFT_HOURS = parseInt(process.env.SHIFT_HOURS || '12', 10);

// Ověření podpisu Twilia (lze vypnout proměnnou TWILIO_VALIDATE=false při lokálním testu).
const validateTwilio =
  process.env.TWILIO_VALIDATE === 'false'
    ? (req, res, next) => next()
    : twilio.webhook({ authToken: process.env.TWILIO_AUTH_TOKEN || '' });

/* =====================  TWILIO – HLASOVÉ MENU (IVR)  ===================== */

// 1) Příchozí hovor – výzva k zadání osobního čísla
app.post('/voice', validateTwilio, (req, res) => {
  const attempt = parseInt(req.query.attempt || '1', 10);
  const twiml = new VoiceResponse();

  if (attempt > MAX_ATTEMPTS) {
    twiml.say(SAY, 'Nebyl potvrzen příchod, zavolejte na vedení B plus H. Na slyšenou.');
    twiml.hangup();
  } else {
    const gather = twiml.gather({
      input: 'dtmf',
      finishOnKey: '#',
      timeout: 10,
      action: `/voice/code?attempt=${attempt}`,
      method: 'POST',
    });
    gather.say(SAY, 'Dobrý den, docházkový systém B plus H. Zadejte své osobní číslo a potvrďte křížkem.');
    twiml.redirect({ method: 'POST' }, `/voice?attempt=${attempt + 1}`);
  }
  res.type('text/xml').send(twiml.toString());
});

// 2) Zpracování zadaného kódu.
//    - Objekt BEZ requires_checkout: rovnou přihlášení (jako dřív), auto-odhlášení po SHIFT_HOURS.
//    - Objekt S requires_checkout: nabídne 1 = přihlášení, 2 = odhlášení (viz /voice/action).
app.post('/voice/code', validateTwilio, async (req, res) => {
  const attempt = parseInt(req.query.attempt || '1', 10);
  const digits = (req.body.Digits || '').trim();
  const callerNumber = req.body.From;
  const callSid = req.body.CallSid;
  const twiml = new VoiceResponse();

  try {
    const { rows } = await pool.query(
      'SELECT id, name, phone, shift_hours FROM employees WHERE pin_code = $1 AND active = TRUE',
      [digits]
    );

    if (rows.length === 0) {
      twiml.say(SAY, 'Neplatný kód.');
      twiml.redirect({ method: 'POST' }, `/voice?attempt=${attempt + 1}`);
      return res.type('text/xml').send(twiml.toString());
    }

    const emp = rows[0];

    // Objekt se určí podle ČÍSLA, ZE KTERÉHO SE VOLÁ (telefon patří objektu).
    const siteRes = await pool.query(
      `SELECT s.id, s.name, s.requires_checkout
         FROM site_phones sp
         JOIN sites s ON s.id = sp.site_id
        WHERE sp.phone_number = $1`,
      [callerNumber]
    );
    const site = siteRes.rows[0] || null;

    if (!site) {
      twiml.say(SAY, 'Toto telefonní číslo není přiřazeno k žádnému objektu. Kontaktujte prosím dispečink. Na slyšenou.');
      twiml.hangup();
      return res.type('text/xml').send(twiml.toString());
    }

    // Objekt s odhlašováním → nabídneme volbu 1/2. Kód (digits) posíláme dál v query.
    if (site.requires_checkout) {
      const gather = twiml.gather({
        input: 'dtmf',
        numDigits: 1,
        timeout: 8,
        action: `/voice/action?code=${encodeURIComponent(digits)}`,
        method: 'POST',
      });
      gather.say(SAY, `Děkujeme, ${emp.name}. Pro přihlášení do služby stiskněte jedna, pro odhlášení stiskněte dva.`);
      twiml.redirect({ method: 'POST' }, `/voice/action?code=${encodeURIComponent(digits)}`);
      return res.type('text/xml').send(twiml.toString());
    }

    // Objekt BEZ odhlašování → chování jako dřív (rovnou přihlášení).
    await doCheckIn(emp, site, callerNumber, callSid, twiml);
  } catch (e) {
    console.error('Chyba zápisu přihlášení:', e.message);
    twiml.say(SAY, 'Omlouváme se, došlo k technické chybě. Zkuste to prosím později.');
    twiml.hangup();
  }
  res.type('text/xml').send(twiml.toString());
});

// 2b) Volba na objektu s odhlašováním: 1 = přihlášení, 2 = odhlášení.
app.post('/voice/action', validateTwilio, async (req, res) => {
  const choice = (req.body.Digits || '').trim();
  const code = (req.query.code || '').trim();
  const callerNumber = req.body.From;
  const callSid = req.body.CallSid;
  const twiml = new VoiceResponse();

  try {
    const { rows } = await pool.query(
      'SELECT id, name, phone, shift_hours FROM employees WHERE pin_code = $1 AND active = TRUE',
      [code]
    );
    const emp = rows[0];
    const siteRes = await pool.query(
      `SELECT s.id, s.name, s.requires_checkout
         FROM site_phones sp JOIN sites s ON s.id = sp.site_id
        WHERE sp.phone_number = $1`,
      [callerNumber]
    );
    const site = siteRes.rows[0] || null;

    if (!emp || !site) {
      twiml.say(SAY, 'Došlo k chybě, zkuste to prosím znovu. Na slyšenou.');
      twiml.hangup();
      return res.type('text/xml').send(twiml.toString());
    }

    if (choice === '2') {
      await doCheckOut(emp, site, twiml);
    } else if (choice === '1') {
      await doCheckIn(emp, site, callerNumber, callSid, twiml);
    } else {
      twiml.say(SAY, 'Nebyla vybrána platná volba. Na slyšenou.');
      twiml.hangup();
    }
  } catch (e) {
    console.error('Chyba volby přihlášení/odhlášení:', e.message);
    twiml.say(SAY, 'Omlouváme se, došlo k technické chybě. Zkuste to prosím později.');
    twiml.hangup();
  }
  res.type('text/xml').send(twiml.toString());
});

// Zjistí, zda je zaměstnanec právě ve službě. Model "poslední událost":
// je ve službě, pokud jeho NEJNOVĚJŠÍ záznam je check_in, který ještě nevypršel
// (po odhlášení je nejnovější check_out → není ve službě a hned zmizí z přehledu).
async function isOnShift(employeeId) {
  const { rows } = await pool.query(
    `SELECT id, event_type FROM attendance_logs
      WHERE employee_id = $1
      ORDER BY called_at DESC LIMIT 1`,
    [employeeId]
  );
  const last = rows[0];
  if (!last || last.event_type !== 'check_in') return null;
  // Ověříme, že přihlášení ještě nevypršelo (auto-odhlášení po délce směny).
  const { rows: valid } = await pool.query(
    `SELECT id FROM attendance_logs
      WHERE id = $1 AND called_at + (hours || ' hours')::interval > now()`,
    [last.id]
  );
  return valid[0] || null;
}

// Otevřené přihlášení = poslední událost je check_in, které dosud nebylo uzavřeno odhlášením.
// Na rozdíl od isOnShift NEbere 12h vypršení – odhlásit se musí jít i po skončení směny
// (kdy už člověk zmizel z přehledu). Rezerva = délka směny + 4 h, aby staré zapomenuté
// přihlášení neblokovalo nástup další den.
async function openCheckIn(employeeId) {
  const { rows } = await pool.query(
    `SELECT id, event_type, expected_checkout FROM attendance_logs
      WHERE employee_id = $1
      ORDER BY called_at DESC LIMIT 1`,
    [employeeId]
  );
  const last = rows[0];
  if (!last || last.event_type !== 'check_in') return null;
  const { rows: fresh } = await pool.query(
    `SELECT id, expected_checkout FROM attendance_logs
      WHERE id = $1
        AND called_at + (hours || ' hours')::interval + interval '4 hours' > now()`,
    [last.id]
  );
  return fresh[0] || null;
}

// Spočítá NEJBLIŽŠÍ očekávaný čas odchodu objektu po zadaném okamžiku.
// Počítá se jednou při přihlášení a uloží se k záznamu (attendance_logs.expected_checkout).
// Den v týdnu se posuzuje podle dne ODCHODU – noční směna z pondělí 18:30
// tak najde úterní čas 6:30. Bez rozvrhu vrátí NULL (odchod se pak nehlídá).
const CHECKOUT_TOLERANCE_MIN = 10; // o kolik dřív než plánovaný čas smí odhlásit

async function computeExpectedCheckout(siteId, fromTs) {
  const { rows } = await pool.query(
    `SELECT MIN(q.local_ts AT TIME ZONE 'Europe/Prague') AS expected
       FROM (
         SELECT ((($1::timestamptz AT TIME ZONE 'Europe/Prague')::date
                  + (g.d || ' days')::interval)::date + cs.expected_time) AS local_ts,
                cs.dow
           FROM site_checkout_schedules cs
           CROSS JOIN generate_series(0, 7) AS g(d)
          WHERE cs.site_id = $2 AND cs.active = TRUE
       ) q
      WHERE q.local_ts > ($1::timestamptz AT TIME ZONE 'Europe/Prague')
        AND position(EXTRACT(ISODOW FROM q.local_ts)::text IN q.dow) > 0`,
    [fromTs, siteId]
  );
  return rows[0]?.expected || null;
}

// Smí se teď odhlásit? Vychází z očekávaného času uloženého u přihlášení.
// Povoleno od (očekávaný čas − tolerance). Vrátí čas jako text, pokud je ještě brzy.
async function checkoutTooEarly(openLog) {
  if (!openLog || !openLog.expected_checkout) return null; // bez rozvrhu lze kdykoli
  const { rows } = await pool.query(
    `SELECT to_char($1::timestamptz AT TIME ZONE 'Europe/Prague', 'HH24:MI') AS t,
            (now() >= $1::timestamptz - ($2 || ' minutes')::interval) AS allowed`,
    [openLog.expected_checkout, CHECKOUT_TOLERANCE_MIN]
  );
  return rows[0].allowed ? null : rows[0].t;
}

// Zapíše přihlášení. Na objektu s odhlašováním navíc uloží očekávaný čas odhlášení.
async function doCheckIn(emp, site, callerNumber, callSid, twiml) {
  // Objekt s odhlašováním: "přihlášen" = má otevřené přihlášení (dokud se neodhlásí).
  // Objekt bez odhlašování: "přihlášen" = přihlášení do 12 h (auto-odhlášení jako dřív).
  const already = site.requires_checkout ? await openCheckIn(emp.id) : await isOnShift(emp.id);
  if (already) {
    twiml.say(SAY, 'Jste již přihlášen ve službě.');
    twiml.hangup();
    return;
  }
  const shiftHours = emp.shift_hours || SHIFT_HOURS;
  // Na objektu s odhlašováním si rovnou uložíme, kdy se má odhlásit.
  const expected = site.requires_checkout
    ? await computeExpectedCheckout(site.id, new Date().toISOString())
    : null;
  await pool.query(
    `INSERT INTO attendance_logs
       (employee_id, site_id, event_type, caller_number, caller_verified, call_sid, hours, expected_checkout)
     VALUES ($1, $2, 'check_in', $3, TRUE, $4, $5, $6)`,
    [emp.id, site.id, callerNumber, callSid, shiftHours, expected]
  );
  twiml.say(SAY, `Děkujeme, ${emp.name}. Byli jste přihlášeni do služby na objektu ${site.name}. Přejeme klidnou směnu, na slyšenou.`);
  twiml.hangup();
}

// Zapíše odhlášení. Uzavře poslední otevřené přihlášení daného zaměstnance.
async function doCheckOut(emp, site, twiml) {
  // Odhlásit lze, dokud má člověk otevřené přihlášení – i po skončení směny (po 12 h),
  // kdy už zmizel z přehledu. Proto openCheckIn, ne isOnShift.
  const open = await openCheckIn(emp.id);
  if (!open) {
    twiml.say(SAY, 'Nejste přihlášen ve službě, odhlášení není možné. Na slyšenou.');
    twiml.hangup();
    return;
  }

  // Pravidlo "dříve odejít nejde": vezmeme dnešní platné časy odchodu objektu
  // a najdeme nejbližší k aktuálnímu času. Pokud je nejbližší v budoucnu → ještě ne.
  const notYet = await checkoutTooEarly(open);
  if (notYet) {
    twiml.say(SAY, `Odhlášení zatím není možné. Odhlaste se prosím až v ${notYet} nebo později. Na slyšenou.`);
    twiml.hangup();
    return;
  }
  await pool.query(
    `INSERT INTO attendance_logs
       (employee_id, site_id, event_type, caller_verified, hours)
     VALUES ($1, $2, 'check_out', TRUE, 0)`,
    [emp.id, site.id]
  );
  twiml.say(SAY, `Děkujeme, ${emp.name}. Byli jste odhlášeni ze služby na objektu ${site.name}. Na slyšenou.`);
  twiml.hangup();
}

/* =====================  REST API PRO CRM  ===================== */

app.post('/api/login', (req, res) => {
  const result = login(req.body.password);
  if (result.error) return res.status(401).json({ error: result.error });
  res.json({ token: result.token });
});

// Kdo je právě přihlášený ve službě = poslední přihlášení + délka směny daného záznamu
// (hodiny zaměstnance) ještě neuplynulo. Po uplynutí z přehledu automaticky zmizí.
app.get('/api/on-site', requireAuth, async (_req, res) => {
  // Bereme POSLEDNÍ událost každého zaměstnance; ve službě je jen ten,
  // jehož poslední událost je platné (nevypršelé) přihlášení. Kdo se odhlásil
  // (poslední událost = check_out), v přehledu není.
  const { rows } = await pool.query(`
    WITH last_event AS (
      SELECT DISTINCT ON (l.employee_id)
             l.employee_id, l.event_type, l.site_id, l.called_at, l.hours, l.expected_checkout
        FROM attendance_logs l
       ORDER BY l.employee_id, l.called_at DESC
    )
    SELECT e.name AS employee, e.pin_code, s.name AS site,
           le.called_at AS since,
           -- U objektu s odhlašováním ukazujeme očekávaný čas odchodu z rozvrhu,
           -- jinak čas automatického odhlášení (nástup + délka směny).
           CASE WHEN COALESCE(s.requires_checkout, FALSE)
                THEN le.expected_checkout
                ELSE le.called_at + (le.hours || ' hours')::interval
           END AS until,
           le.hours,
           COALESCE(s.requires_checkout, FALSE) AS requires_checkout,
           le.expected_checkout,
           -- Neodhlásil se, i když už měl.
           (COALESCE(s.requires_checkout, FALSE)
            AND le.expected_checkout IS NOT NULL
            AND now() > le.expected_checkout) AS overdue
      FROM last_event le
      JOIN employees e ON e.id = le.employee_id
 LEFT JOIN sites s     ON s.id = le.site_id
     WHERE le.event_type = 'check_in'
       AND (
             -- Běžný objekt: automatické odhlášení po délce směny.
             (COALESCE(s.requires_checkout, FALSE) = FALSE
              AND le.called_at + (le.hours || ' hours')::interval > now())
             -- Objekt s odhlašováním: drží se, dokud se neodhlásí,
             -- nejdéle však délka směny + 4 h (pak už se může znovu přihlásit).
          OR (COALESCE(s.requires_checkout, FALSE) = TRUE
              AND le.called_at + (le.hours || ' hours')::interval + interval '4 hours' > now())
           )
     ORDER BY le.called_at DESC
  `);
  res.json(rows);
});

// Historie docházky s filtrem: ?from=&to=&site_id=&employee_id=
app.get('/api/attendance', requireAuth, async (req, res) => {
  const { from, to, site_id, employee_id } = req.query;
  const params = [];
  const where = [];
  if (from) { params.push(from); where.push(`l.called_at >= $${params.length}`); }
  if (to) { params.push(to); where.push(`l.called_at < ($${params.length}::date + interval '1 day')`); }
  if (site_id) { params.push(site_id); where.push(`l.site_id = $${params.length}`); }
  if (employee_id) { params.push(employee_id); where.push(`l.employee_id = $${params.length}`); }

  const { rows } = await pool.query(
    `SELECT l.id, e.name AS employee, e.pin_code, s.name AS site, l.site_id, l.event_type,
            l.called_at, l.caller_number, l.hours
       FROM attendance_logs l
       JOIN employees e ON e.id = l.employee_id
  LEFT JOIN sites s     ON s.id = l.site_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY l.called_at DESC
       LIMIT 2000`,
    params
  );
  res.json(rows);
});

// Úprava záznamu docházky – počet hodin a případně objekt
app.put('/api/attendance/:id', requireAuth, async (req, res) => {
  const { hours, site_id } = req.body;
  const { rows } = await pool.query(
    'UPDATE attendance_logs SET hours = $1, site_id = $2 WHERE id = $3 RETURNING id',
    [hours, site_id || null, req.params.id]
  );
  if (rows.length === 0) return res.status(404).json({ error: 'Záznam nenalezen' });
  res.json({ ok: true });
});

// Smazání záznamu docházky (pro opravu chyb)
app.delete('/api/attendance/:id', requireAuth, async (req, res) => {
  await pool.query('DELETE FROM attendance_logs WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// --- Zaměstnanci ---
app.get('/api/employees', requireAuth, async (_req, res) => {
  const { rows } = await pool.query('SELECT * FROM employees ORDER BY name');
  res.json(rows);
});
app.post('/api/employees', requireAuth, async (req, res) => {
  const { name, phone, pin_code } = req.body;
  const shift = Math.min(24, Math.max(1, parseInt(req.body.shift_hours, 10) || 12));
  try {
    const { rows } = await pool.query(
      'INSERT INTO employees (name, phone, pin_code, shift_hours) VALUES ($1,$2,$3,$4) RETURNING *',
      [name, phone || null, pin_code, shift]
    );
    res.json(rows[0]);
  } catch (e) {
    res.status(400).json({ error: e.message.includes('unique') ? 'Kód už existuje' : e.message });
  }
});
app.put('/api/employees/:id', requireAuth, async (req, res) => {
  const { name, phone, pin_code, active } = req.body;
  const shift = Math.min(24, Math.max(1, parseInt(req.body.shift_hours, 10) || 12));
  const { rows } = await pool.query(
    'UPDATE employees SET name=$1, phone=$2, pin_code=$3, active=$4, shift_hours=$5 WHERE id=$6 RETURNING *',
    [name, phone || null, pin_code, active, shift, req.params.id]
  );
  res.json(rows[0]);
});

// --- Objekty ---
app.get('/api/sites', requireAuth, async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT s.id, s.name, s.address, s.requires_checkout,
      COALESCE((SELECT json_agg(json_build_object('id', sp.id, 'phone_number', sp.phone_number)
                                ORDER BY sp.phone_number)
                  FROM site_phones sp WHERE sp.site_id = s.id), '[]') AS phones,
      COALESCE((SELECT json_agg(json_build_object('id', sc.id,
                                'expected_time', to_char(sc.expected_time, 'HH24:MI'),
                                'dow', sc.dow,
                                'first_alert_min', sc.first_alert_min,
                                'second_alert_min', sc.second_alert_min)
                                ORDER BY sc.expected_time)
                  FROM site_schedules sc WHERE sc.site_id = s.id), '[]') AS schedules,
      COALESCE((SELECT json_agg(json_build_object('id', ct.id, 'phone_number', ct.phone_number)
                                ORDER BY ct.phone_number)
                  FROM site_contacts ct WHERE ct.site_id = s.id), '[]') AS contacts,
      COALESCE((SELECT json_agg(json_build_object('id', cs.id,
                                'expected_time', to_char(cs.expected_time, 'HH24:MI'),
                                'dow', cs.dow)
                                ORDER BY cs.expected_time)
                  FROM site_checkout_schedules cs WHERE cs.site_id = s.id), '[]') AS checkout_schedules
      FROM sites s
  ORDER BY s.name
  `);
  res.json(rows);
});
app.post('/api/sites', requireAuth, async (req, res) => {
  const { name, address } = req.body;
  const { rows } = await pool.query(
    'INSERT INTO sites (name, address) VALUES ($1,$2) RETURNING *',
    [name, address || null]
  );
  res.json(rows[0]);
});
app.delete('/api/sites/:id', requireAuth, async (req, res) => {
  await pool.query('DELETE FROM sites WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// Úprava objektu – zatím jen přepínač "vyžadovat odhlášení".
app.put('/api/sites/:id', requireAuth, async (req, res) => {
  const { requires_checkout } = req.body;
  const { rows } = await pool.query(
    'UPDATE sites SET requires_checkout = $1 WHERE id = $2 RETURNING id, requires_checkout',
    [!!requires_checkout, req.params.id]
  );
  if (rows.length === 0) return res.status(404).json({ error: 'Objekt nenalezen' });
  res.json(rows[0]);
});

// Přiřazení telefonního čísla k objektu
app.post('/api/sites/:id/phones', requireAuth, async (req, res) => {
  const { phone_number } = req.body;
  if (!phone_number) return res.status(400).json({ error: 'Zadejte číslo' });
  try {
    const { rows } = await pool.query(
      'INSERT INTO site_phones (site_id, phone_number) VALUES ($1,$2) RETURNING *',
      [req.params.id, phone_number.trim()]
    );
    res.json(rows[0]);
  } catch (e) {
    res.status(400).json({
      error: e.message.includes('unique')
        ? 'Toto číslo už je přiřazeno k některému objektu'
        : e.message,
    });
  }
});
app.delete('/api/sites/:id/phones/:phoneId', requireAuth, async (req, res) => {
  await pool.query('DELETE FROM site_phones WHERE id = $1', [req.params.phoneId]);
  res.json({ ok: true });
});

// --- Očekávané časy příchodu na pobočku (hlídání) ---
app.post('/api/sites/:id/schedules', requireAuth, async (req, res) => {
  const { expected_time, dow } = req.body;
  if (!expected_time) return res.status(400).json({ error: 'Zadejte čas' });
  const days = (dow || '1234567').toString().replace(/[^1-7]/g, '') || '1234567';
  const { rows } = await pool.query(
    `INSERT INTO site_schedules (site_id, expected_time, dow) VALUES ($1, $2, $3)
     RETURNING id, to_char(expected_time, 'HH24:MI') AS expected_time, dow`,
    [req.params.id, expected_time, days]
  );
  res.json(rows[0]);
});
app.delete('/api/schedules/:id', requireAuth, async (req, res) => {
  await pool.query('DELETE FROM site_schedules WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// --- Očekávané ODCHODY (jen objekty s requires_checkout) ---
app.post('/api/sites/:id/checkout-schedules', requireAuth, async (req, res) => {
  const { expected_time, dow } = req.body;
  if (!expected_time) return res.status(400).json({ error: 'Zadejte čas' });
  const days = (dow || '1234567').toString().replace(/[^1-7]/g, '') || '1234567';
  const { rows } = await pool.query(
    `INSERT INTO site_checkout_schedules (site_id, expected_time, dow) VALUES ($1, $2, $3)
     RETURNING id, to_char(expected_time, 'HH24:MI') AS expected_time, dow`,
    [req.params.id, expected_time, days]
  );
  res.json(rows[0]);
});
app.delete('/api/checkout-schedules/:id', requireAuth, async (req, res) => {
  await pool.query('DELETE FROM site_checkout_schedules WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// --- Kontaktní čísla pobočky pro 2. eskalaci (+30 min) ---
app.post('/api/sites/:id/contacts', requireAuth, async (req, res) => {
  const { phone_number } = req.body;
  if (!phone_number) return res.status(400).json({ error: 'Zadejte číslo' });
  const { rows } = await pool.query(
    'INSERT INTO site_contacts (site_id, phone_number) VALUES ($1, $2) RETURNING *',
    [req.params.id, phone_number.trim()]
  );
  res.json(rows[0]);
});
app.delete('/api/contacts/:id', requireAuth, async (req, res) => {
  await pool.query('DELETE FROM site_contacts WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// Posledních pár odeslaných upozornění (pro přehled v hlídání)
app.get('/api/schedule-alerts', requireAuth, async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT a.id, a.alert_date, a.level, a.sent_at,
           to_char(sc.expected_time, 'HH24:MI') AS expected_time, s.name AS site
      FROM schedule_alerts a
      JOIN site_schedules sc ON sc.id = a.schedule_id
      JOIN sites s ON s.id = sc.site_id
     ORDER BY a.sent_at DESC
     LIMIT 50
  `);
  res.json(rows);
});

// --- Směny (pro hlídání nenahlášení) ---
app.get('/api/shifts', requireAuth, async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT sh.*, e.name AS employee, si.name AS site
      FROM shifts sh
      JOIN employees e ON e.id = sh.employee_id
 LEFT JOIN sites si    ON si.id = sh.site_id
     WHERE sh.starts_at > now() - interval '2 days'
     ORDER BY sh.starts_at DESC
  `);
  res.json(rows);
});
app.post('/api/shifts', requireAuth, async (req, res) => {
  const { employee_id, site_id, starts_at, grace_min } = req.body;
  const { rows } = await pool.query(
    'INSERT INTO shifts (employee_id, site_id, starts_at, grace_min) VALUES ($1,$2,$3,$4) RETURNING *',
    [employee_id, site_id || null, starts_at, grace_min || 15]
  );
  res.json(rows[0]);
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));

/* =====================  FRONTEND (statické soubory z buildu)  ===================== */
const clientDist = join(__dirname, '..', 'client', 'dist');
if (existsSync(clientDist)) {
  app.use(express.static(clientDist));
  // SPA fallback – vše ostatní (kromě API a voice) servíruje index.html
  app.get(/^(?!\/(api|voice)).*/, (_req, res) => {
    res.sendFile(join(clientDist, 'index.html'));
  });
}

/* =====================  START  ===================== */
const PORT = process.env.PORT || 3000;
migrate()
  .then(() => {
    startShiftWatcher();
    app.listen(PORT, () => console.log(`Server běží na portu ${PORT}`));
  })
  .catch((e) => {
    console.error('Chyba při startu (migrace):', e);
    process.exit(1);
  });

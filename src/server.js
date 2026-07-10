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
    `SELECT id, event_type FROM attendance_logs
      WHERE employee_id = $1
      ORDER BY called_at DESC LIMIT 1`,
    [employeeId]
  );
  const last = rows[0];
  if (!last || last.event_type !== 'check_in') return null;
  const { rows: fresh } = await pool.query(
    `SELECT id FROM attendance_logs
      WHERE id = $1
        AND called_at + (hours || ' hours')::interval + interval '4 hours' > now()`,
    [last.id]
  );
  return fresh[0] || null;
}

// Naplánovaný čas odhlášení = nejbližší očekávaný čas příchodu objektu (dnešní) + délka směny.
// Pokud objekt nemá žádný rozvrh, vrátí NULL (odhlášení se pak nehlídá časově).
async function computeExpectedCheckout(siteId, shiftHours) {
  const { rows } = await pool.query(
    `SELECT to_char(expected_time, 'HH24:MI') AS t FROM site_schedules
      WHERE site_id = $1 AND active = TRUE`,
    [siteId]
  );

  // Objekt bez rozvrhu → zakotvíme na skutečný čas příchodu + délka směny,
  // aby se odhlášení hlídalo i tam, kde není nastavený očekávaný čas příchodu.
  if (rows.length === 0) {
    const { rows: ts } = await pool.query(
      `SELECT now() + ($1 || ' hours')::interval AS ts`, [shiftHours]
    );
    return ts[0]?.ts || null;
  }

  // Vybereme rozvrh nejbližší aktuálnímu času (ten, na který se člověk hlásí).
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Prague', hour12: false, hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date());
  const g = (t) => parts.find((p) => p.type === t)?.value;
  let nowH = parseInt(g('hour'), 10); if (nowH === 24) nowH = 0;
  const nowMin = nowH * 60 + parseInt(g('minute'), 10);
  let best = null, bestDiff = Infinity;
  for (const r of rows) {
    const [h, m] = r.t.split(':').map(Number);
    const diff = Math.abs(h * 60 + m - nowMin);
    if (diff < bestDiff) { bestDiff = diff; best = r.t; }
  }

  // expected_checkout = dnešní pražské datum v čase rozvrhu + délka směny (interval).
  // Přičtení intervalu správně přeteče přes půlnoc: 20:00 + 12 h = 08:00 příštího dne.
  const { rows: tsRows } = await pool.query(
    `SELECT (((now() AT TIME ZONE 'Europe/Prague')::date + $1::time) AT TIME ZONE 'Europe/Prague')
            + ($2 || ' hours')::interval AS ts`,
    [best, shiftHours]
  );
  return tsRows[0]?.ts || null;
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
  const expectedCheckout = site.requires_checkout
    ? await computeExpectedCheckout(site.id, shiftHours)
    : null;
  await pool.query(
    `INSERT INTO attendance_logs
       (employee_id, site_id, event_type, caller_number, caller_verified, call_sid, hours, expected_checkout)
     VALUES ($1, $2, 'check_in', $3, TRUE, $4, $5, $6)`,
    [emp.id, site.id, callerNumber, callSid, shiftHours, expectedCheckout]
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
             l.employee_id, l.event_type, l.site_id, l.called_at, l.hours
        FROM attendance_logs l
       ORDER BY l.employee_id, l.called_at DESC
    )
    SELECT e.name AS employee, e.pin_code, s.name AS site,
           le.called_at AS since,
           le.called_at + (le.hours || ' hours')::interval AS until,
           le.hours
      FROM last_event le
      JOIN employees e ON e.id = le.employee_id
 LEFT JOIN sites s     ON s.id = le.site_id
     WHERE le.event_type = 'check_in'
       AND le.called_at + (le.hours || ' hours')::interval > now()
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
  const shift = Math.min(12, Math.max(1, parseInt(req.body.shift_hours, 10) || 12));
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
  const shift = Math.min(12, Math.max(1, parseInt(req.body.shift_hours, 10) || 12));
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
                  FROM site_contacts ct WHERE ct.site_id = s.id), '[]') AS contacts
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

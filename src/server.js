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
    twiml.say(SAY, 'Překročen počet pokusů. Kontaktujte prosím dispečink. Na slyšenou.');
    twiml.hangup();
  } else {
    const gather = twiml.gather({
      input: 'dtmf',
      finishOnKey: '#',
      timeout: 10,
      action: `/voice/code?attempt=${attempt}`,
      method: 'POST',
    });
    gather.say(SAY, 'Dobrý den. Zadejte prosím své osobní číslo a potvrďte křížkem.');
    twiml.redirect({ method: 'POST' }, `/voice?attempt=${attempt + 1}`);
  }
  res.type('text/xml').send(twiml.toString());
});

// 2) Zpracování zadaného kódu = přihlášení na pracoviště (zápis rovnou).
//    Zaměstnanec se NEodhlašuje – systém ho automaticky "odhlásí" po SHIFT_HOURS hodinách
//    (přihlášený je ten, jehož poslední přihlášení není starší než tato doba).
app.post('/voice/code', validateTwilio, async (req, res) => {
  const attempt = parseInt(req.query.attempt || '1', 10);
  const digits = (req.body.Digits || '').trim();
  const callerNumber = req.body.From;
  const calledNumber = req.body.To;
  const callSid = req.body.CallSid;
  const twiml = new VoiceResponse();

  try {
    const { rows } = await pool.query(
      'SELECT id, name, phone FROM employees WHERE pin_code = $1 AND active = TRUE',
      [digits]
    );

    if (rows.length === 0) {
      twiml.say(SAY, 'Neplatný kód.');
      twiml.redirect({ method: 'POST' }, `/voice?attempt=${attempt + 1}`);
    } else {
      const emp = rows[0];
      const siteRes = await pool.query('SELECT id, name FROM sites WHERE phone_number = $1', [
        calledNumber,
      ]);
      const site = siteRes.rows[0] || null;

      // Ověřování čísla volajícího je vypnuté – telefon se mezi zaměstnanci sdílí,
      // jedinou pojistkou je osobní kód. Číslo, ze kterého se volalo, se i tak ukládá pro evidenci.
      await pool.query(
        `INSERT INTO attendance_logs
           (employee_id, site_id, event_type, caller_number, caller_verified, call_sid)
         VALUES ($1, $2, 'check_in', $3, TRUE, $4)`,
        [emp.id, site ? site.id : null, callerNumber, callSid]
      );

      const where = site ? ` na objektu ${site.name}` : '';
      twiml.say(
        SAY,
        `Děkujeme, ${emp.name}. Byli jste přihlášeni do služby${where}. Na slyšenou.`
      );
      twiml.hangup();
    }
  } catch (e) {
    console.error('Chyba zápisu přihlášení:', e.message);
    twiml.say(SAY, 'Omlouváme se, došlo k technické chybě. Zkuste to prosím později.');
    twiml.hangup();
  }
  res.type('text/xml').send(twiml.toString());
});

/* =====================  REST API PRO CRM  ===================== */

app.post('/api/login', (req, res) => {
  const token = login(req.body.password);
  if (!token) return res.status(401).json({ error: 'Nesprávné heslo' });
  res.json({ token });
});

// Kdo je právě přihlášený ve službě = poslední přihlášení není starší než SHIFT_HOURS hodin.
// Po uplynutí této doby zaměstnanec z přehledu automaticky zmizí (žádné rušení záznamů není potřeba).
app.get('/api/on-site', requireAuth, async (_req, res) => {
  const { rows } = await pool.query(
    `
    SELECT DISTINCT ON (l.employee_id)
           e.name AS employee, e.pin_code, s.name AS site,
           l.called_at AS since,
           l.called_at + ($1 || ' hours')::interval AS until
      FROM attendance_logs l
      JOIN employees e ON e.id = l.employee_id
 LEFT JOIN sites s     ON s.id = l.site_id
     WHERE l.event_type = 'check_in'
       AND l.called_at >= now() - ($1 || ' hours')::interval
     ORDER BY l.employee_id, l.called_at DESC
  `,
    [SHIFT_HOURS]
  );
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
    `SELECT l.id, e.name AS employee, e.pin_code, s.name AS site, l.event_type,
            l.called_at, l.caller_number, l.caller_verified
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

// --- Zaměstnanci ---
app.get('/api/employees', requireAuth, async (_req, res) => {
  const { rows } = await pool.query('SELECT * FROM employees ORDER BY name');
  res.json(rows);
});
app.post('/api/employees', requireAuth, async (req, res) => {
  const { name, phone, pin_code } = req.body;
  try {
    const { rows } = await pool.query(
      'INSERT INTO employees (name, phone, pin_code) VALUES ($1,$2,$3) RETURNING *',
      [name, phone || null, pin_code]
    );
    res.json(rows[0]);
  } catch (e) {
    res.status(400).json({ error: e.message.includes('unique') ? 'Kód už existuje' : e.message });
  }
});
app.put('/api/employees/:id', requireAuth, async (req, res) => {
  const { name, phone, pin_code, active } = req.body;
  const { rows } = await pool.query(
    'UPDATE employees SET name=$1, phone=$2, pin_code=$3, active=$4 WHERE id=$5 RETURNING *',
    [name, phone || null, pin_code, active, req.params.id]
  );
  res.json(rows[0]);
});

// --- Objekty ---
app.get('/api/sites', requireAuth, async (_req, res) => {
  const { rows } = await pool.query('SELECT * FROM sites ORDER BY name');
  res.json(rows);
});
app.post('/api/sites', requireAuth, async (req, res) => {
  const { name, address, phone_number } = req.body;
  const { rows } = await pool.query(
    'INSERT INTO sites (name, address, phone_number) VALUES ($1,$2,$3) RETURNING *',
    [name, address || null, phone_number || null]
  );
  res.json(rows[0]);
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

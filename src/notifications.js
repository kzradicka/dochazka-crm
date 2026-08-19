import twilio from 'twilio';
import pool from './db.js';

// Twilio klient (volitelné) – pro odchozí hovory s namluvenou hláškou.
let twilioClient = null;
if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
  twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
}

// Časy eskalace (v minutách od očekávaného příchodu):
// 1. hovor na čísla pobočky po 10 min, 2. hovor na kontaktní čísla po 15 min.
const FIRST_ALERT_MIN = 10;
const SECOND_ALERT_MIN = 15;

// Jak dlouho PŘED očekávaným časem se počítá nahlášení (aby se zachytili i ti,
// kdo dorazí dříve). Pozor: nesmí být delší než odstup mezi dvěma směnami téhož
// objektu, jinak by se ranní nahlášení započítalo i do okna večerní směny.
const CHECK_IN_WINDOW_MIN = 180;

// Český hlas pro automat (stejný jako telefonní linka pro nahlašování).
const SAY = { voice: 'Google.cs-CZ-Standard-A', language: 'cs-CZ' };

// Zavolá na číslo a přehraje namluvenou hlášku.
// Když není Twilio nastavené, jen zaloguje (aby šlo testovat bez Twilia).
async function placeCall(to, message) {
  if (!twilioClient || !process.env.TWILIO_NUMBER) {
    console.warn('Hovor nenastaven (chybí TWILIO_*):', to, '|', message);
    return;
  }
  try {
    const vr = new twilio.twiml.VoiceResponse();
    vr.pause({ length: 1 }); // krátká pauza, ať se neuřízne začátek
    vr.say(SAY, message);
    await twilioClient.calls.create({ from: process.env.TWILIO_NUMBER, to, twiml: vr.toString() });
    console.log('Hovor zahájen:', to);
  } catch (e) {
    console.error('Chyba hovoru na', to, ':', e.message);
  }
}

// Pauza mezi hovory, aby se na stejné číslo nevolalo, dokud předchozí hovor neskončí.
// Twilio jinak druhý hovor založí na obsazenou linku a fyzicky se dovolá jen první.
const CALL_GAP_SEC = 45;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Obvolá seznam čísel postupně, s pauzou mezi jednotlivými hovory (ne před prvním).
async function callSequentially(numbers, message) {
  for (let i = 0; i < numbers.length; i++) {
    if (i > 0) await sleep(CALL_GAP_SEC * 1000);
    await placeCall(numbers[i], message);
  }
}

// Aktuální čas v Evropě/Praha – datum, minuty od půlnoci a den v týdnu (1=Po … 7=Ne).
function pragueNow() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Prague', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short',
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t)?.value;
  let hh = parseInt(get('hour'), 10);
  if (hh === 24) hh = 0;
  const mm = parseInt(get('minute'), 10);
  const wk = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  return {
    dateISO: `${get('year')}-${get('month')}-${get('day')}`,
    minutesOfDay: hh * 60 + mm,
    dow: wk[get('weekday')],
  };
}

const pad = (n) => String(n).padStart(2, '0');
const minToTime = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;

async function alertAlreadySent(scheduleId, dateISO, level) {
  const { rows } = await pool.query(
    'SELECT 1 FROM schedule_alerts WHERE schedule_id = $1 AND alert_date = $2 AND level = $3 LIMIT 1',
    [scheduleId, dateISO, level]
  );
  return rows.length > 0;
}

async function recordAlert(scheduleId, dateISO, level) {
  await pool.query(
    `INSERT INTO schedule_alerts (schedule_id, alert_date, level)
     VALUES ($1, $2, $3) ON CONFLICT (schedule_id, alert_date, level) DO NOTHING`,
    [scheduleId, dateISO, level]
  );
}

// Hlavní kontrola – běží každou minutu.
// Pro každý očekávaný čas příchodu, který už uplynul a nikdo se na pobočce nenahlásil,
// zavolá v +10 min na čísla pobočky a v +15 min na kontaktní čísla.
async function checkSiteSchedules() {
  const { dateISO, minutesOfDay, dow } = pragueNow();

  const { rows: schedules } = await pool.query(`
    SELECT sc.id, sc.site_id, to_char(sc.expected_time, 'HH24:MI') AS expected_time,
           sc.dow, sc.first_alert_min, sc.second_alert_min, s.name AS site_name
      FROM site_schedules sc
      JOIN sites s ON s.id = sc.site_id
     WHERE sc.active = TRUE
  `);

  for (const sc of schedules) {
    // Platí čas dnes (dle dnů v týdnu)?
    if (!String(sc.dow || '').includes(String(dow))) continue;

    const [eh, em] = sc.expected_time.split(':').map(Number);
    const expectedMin = eh * 60 + em;
    const elapsed = minutesOfDay - expectedMin;

    // Ještě nenastal čas první eskalace, nebo už je příliš pozdě (vyhneme se hlášení ze starých časů).
    if (elapsed < FIRST_ALERT_MIN) continue;
    if (elapsed > 240) continue;

    // Nahlásil se na pobočce dnes někdo v okně [očekávaný čas − CHECK_IN_WINDOW_MIN, teď]?
    const windowStart = minToTime(Math.max(0, expectedMin - CHECK_IN_WINDOW_MIN));
    const { rows: chk } = await pool.query(
      `SELECT 1 FROM attendance_logs
        WHERE site_id = $1 AND event_type = 'check_in'
          AND (called_at AT TIME ZONE 'Europe/Prague')::date = $2::date
          AND (called_at AT TIME ZONE 'Europe/Prague')::time >= $3::time
        LIMIT 1`,
      [sc.site_id, dateISO, windowStart]
    );
    if (chk.length > 0) continue; // někdo se nahlásil → žádné upozornění

    // 1. eskalace (+10 min): hovor na čísla pobočky
    if (elapsed >= FIRST_ALERT_MIN && !(await alertAlreadySent(sc.id, dateISO, 1))) {
      const { rows: phones } = await pool.query(
        'SELECT phone_number FROM site_phones WHERE site_id = $1',
        [sc.site_id]
      );
      // Zamkneme eskalaci HNED, ještě před obvoláním. Obvolání s pauzami může trvat
      // déle než interval (60 s), takže bez tohoto by ji další tick mohl spustit znovu.
      await recordAlert(sc.id, dateISO, 1);
      const message = `Dobrý den, docházkový systém B plus H dosud nezaznamenal nástup do služby na objektu ${sc.site_name}. Zavolejte ihned na linku docházkového systému a nahlaste se do služby. Na slyšenou.`;
      console.log(`Hovor 1 (pobočka) zahájen: ${sc.site_name} ${sc.expected_time}`);
      await callSequentially(phones.map((p) => p.phone_number), message);
    }

    // 2. eskalace (+15 min): hovor na kontaktní (emergency) čísla
    if (elapsed >= SECOND_ALERT_MIN && !(await alertAlreadySent(sc.id, dateISO, 2))) {
      const { rows: contacts } = await pool.query(
        'SELECT phone_number FROM site_contacts WHERE site_id = $1',
        [sc.site_id]
      );
      await recordAlert(sc.id, dateISO, 2);
      const message = `Dobrý den, varování. Docházkový systém B plus H doposud nezaznamenal nástup do služby na objektu ${sc.site_name}. Prověřte ihned telefonicky objekt ${sc.site_name}. Děkuji.`;
      console.log(`Hovor 2 (kontakty) zahájen: ${sc.site_name} ${sc.expected_time}`);
      await callSequentially(contacts.map((c) => c.phone_number), message);
    }
  }
}

// Hlídání CHYBĚJÍCÍHO ODHLÁŠENÍ – zrcadlo hlídání příchodů, ale nad časy ODCHODU.
// Pro každý dnešní platný čas odchodu objektu (site_checkout_schedules):
//   pokud v okně [čas − 60 min, teď] nikdo neprovedl check_out,
//   +10 min po čase → hovor na čísla objektu (level 1),
//   +15 min po čase → hovor na kontaktní čísla (level 2).
async function checkMissingCheckouts() {
  const { dateISO, minutesOfDay, dow } = pragueNow();

  const { rows: schedules } = await pool.query(`
    SELECT cs.id, cs.site_id, to_char(cs.expected_time, 'HH24:MI') AS expected_time,
           cs.dow, s.name AS site_name
      FROM site_checkout_schedules cs
      JOIN sites s ON s.id = cs.site_id
     WHERE cs.active = TRUE AND s.requires_checkout = TRUE
  `);

  for (const cs of schedules) {
    if (!String(cs.dow || '').includes(String(dow))) continue;

    const [eh, em] = cs.expected_time.split(':').map(Number);
    const expectedMin = eh * 60 + em;
    const elapsed = minutesOfDay - expectedMin;

    if (elapsed < 10) continue;   // ještě nenastal čas 1. eskalace
    if (elapsed > 240) continue;  // příliš staré – neřešíme

    // Odhlásil se dnes někdo na objektu v okně [čas odchodu − 60 min, teď]?
    const windowStart = minToTime(Math.max(0, expectedMin - 60));
    const { rows: chk } = await pool.query(
      `SELECT 1 FROM attendance_logs
        WHERE site_id = $1 AND event_type = 'check_out'
          AND (called_at AT TIME ZONE 'Europe/Prague')::date = $2::date
          AND (called_at AT TIME ZONE 'Europe/Prague')::time >= $3::time
        LIMIT 1`,
      [cs.site_id, dateISO, windowStart]
    );
    if (chk.length > 0) continue; // někdo se odhlásil → žádné upozornění

    // 1. eskalace (+10 min): hovor na čísla objektu
    if (elapsed >= 10 && !(await checkoutAlertSent(cs.id, dateISO, 1))) {
      const { rows: phones } = await pool.query(
        'SELECT phone_number FROM site_phones WHERE site_id = $1', [cs.site_id]
      );
      await recordCheckoutAlert(cs.id, dateISO, 1);
      const message = `Dobrý den, docházkový systém B plus H zaznamenal, že na objektu ${cs.site_name} nebylo provedeno odhlášení ze služby. Odhlaste se prosím ihned na lince docházkového systému. Na slyšenou.`;
      console.log(`Odhlášení – hovor 1 (objekt) zahájen: ${cs.site_name} ${cs.expected_time}`);
      await callSequentially(phones.map((p) => p.phone_number), message);
    }

    // 2. eskalace (+15 min): hovor na kontaktní čísla
    if (elapsed >= 15 && !(await checkoutAlertSent(cs.id, dateISO, 2))) {
      const { rows: contacts } = await pool.query(
        'SELECT phone_number FROM site_contacts WHERE site_id = $1', [cs.site_id]
      );
      await recordCheckoutAlert(cs.id, dateISO, 2);
      const message = `Dobrý den, varování. Na objektu ${cs.site_name} se strážný po skončení směny neodhlásil ze služby. Prověřte prosím ihned objekt ${cs.site_name}. Děkuji.`;
      console.log(`Odhlášení – hovor 2 (kontakty) zahájen: ${cs.site_name} ${cs.expected_time}`);
      await callSequentially(contacts.map((c) => c.phone_number), message);
    }
  }
}

async function checkoutAlertSent(scheduleId, dateISO, level) {
  const { rows } = await pool.query(
    'SELECT 1 FROM checkout_schedule_alerts WHERE checkout_schedule_id = $1 AND alert_date = $2 AND level = $3 LIMIT 1',
    [scheduleId, dateISO, level]
  );
  return rows.length > 0;
}
async function recordCheckoutAlert(scheduleId, dateISO, level) {
  await pool.query(
    `INSERT INTO checkout_schedule_alerts (checkout_schedule_id, alert_date, level)
     VALUES ($1, $2, $3) ON CONFLICT (checkout_schedule_id, alert_date, level) DO NOTHING`,
    [scheduleId, dateISO, level]
  );
}

// Spustí hlídání každou minutu.
export function startShiftWatcher() {
  setInterval(() => {
    checkSiteSchedules().catch((e) => console.error('checkSiteSchedules:', e.message));
    checkMissingCheckouts().catch((e) => console.error('checkMissingCheckouts:', e.message));
  }, 60 * 1000);
  console.log('Hlídání příchodů a odhlášení per pobočka spuštěno (interval 60 s).');
}

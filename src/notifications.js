import twilio from 'twilio';
import pool from './db.js';

// Twilio klient (volitelné) – pro odchozí SMS notifikace.
let twilioClient = null;
if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
  twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
}

// Časy eskalace (v minutách od očekávaného příchodu):
// 1. SMS na čísla pobočky po 10 min, 2. SMS na kontaktní čísla po 15 min.
const FIRST_ALERT_MIN = 10;
const SECOND_ALERT_MIN = 15;

// Odešle SMS. Když není Twilio nastavené, jen zaloguje (aby šlo testovat bez SMS).
async function sendSms(to, body) {
  if (!twilioClient || !process.env.TWILIO_NUMBER) {
    console.warn('SMS nenastavena (chybí TWILIO_*):', to, '|', body);
    return;
  }
  try {
    await twilioClient.messages.create({ from: process.env.TWILIO_NUMBER, to, body });
    console.log('SMS odeslána:', to);
  } catch (e) {
    console.error('Chyba odeslání SMS na', to, ':', e.message);
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
// pošle ve +15 min SMS na čísla pobočky a ve +30 min SMS na kontaktní čísla.
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

    // Nahlásil se na pobočce dnes někdo v okně [očekávaný čas − 60 min, teď]?
    const windowStart = minToTime(Math.max(0, expectedMin - 60));
    const { rows: chk } = await pool.query(
      `SELECT 1 FROM attendance_logs
        WHERE site_id = $1 AND event_type = 'check_in'
          AND (called_at AT TIME ZONE 'Europe/Prague')::date = $2::date
          AND (called_at AT TIME ZONE 'Europe/Prague')::time >= $3::time
        LIMIT 1`,
      [sc.site_id, dateISO, windowStart]
    );
    if (chk.length > 0) continue; // někdo se nahlásil → žádné upozornění

    // 1. eskalace (+15 min): SMS na čísla pobočky
    if (elapsed >= FIRST_ALERT_MIN && !(await alertAlreadySent(sc.id, dateISO, 1))) {
      const { rows: phones } = await pool.query(
        'SELECT phone_number FROM site_phones WHERE site_id = $1',
        [sc.site_id]
      );
      const body = `Docházka – pobočka ${sc.site_name}: v ${sc.expected_time} se nikdo nenahlásil ke službě.`;
      for (const p of phones) await sendSms(p.phone_number, body);
      await recordAlert(sc.id, dateISO, 1);
      console.log(`Upozornění 1 (pobočka) odesláno: ${sc.site_name} ${sc.expected_time}`);
    }

    // 2. eskalace (+30 min): SMS na kontaktní čísla
    if (elapsed >= SECOND_ALERT_MIN && !(await alertAlreadySent(sc.id, dateISO, 2))) {
      const { rows: contacts } = await pool.query(
        'SELECT phone_number FROM site_contacts WHERE site_id = $1',
        [sc.site_id]
      );
      const body = `Docházka – pobočka ${sc.site_name}: stále se nikdo nenahlásil k příchodu v ${sc.expected_time}. Prosím prověřte.`;
      for (const c of contacts) await sendSms(c.phone_number, body);
      await recordAlert(sc.id, dateISO, 2);
      console.log(`Upozornění 2 (kontakty) odesláno: ${sc.site_name} ${sc.expected_time}`);
    }
  }
}

// Spustí hlídání každou minutu.
export function startShiftWatcher() {
  setInterval(() => {
    checkSiteSchedules().catch((e) => console.error('checkSiteSchedules:', e.message));
  }, 60 * 1000);
  console.log('Hlídání příchodů per pobočka spuštěno (interval 60 s).');
}

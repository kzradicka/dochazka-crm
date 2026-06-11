import nodemailer from 'nodemailer';
import twilio from 'twilio';
import pool from './db.js';

// E-mail (volitelné) – nastaví se, jen pokud jsou vyplněné SMTP proměnné.
let mailer = null;
if (process.env.SMTP_HOST) {
  mailer = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

// Twilio klient (volitelné) – pro odchozí SMS notifikace.
let twilioClient = null;
if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
  twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
}

async function sendAlert(text) {
  const to = process.env.DISPATCHER_EMAIL;
  if (mailer && to) {
    try {
      await mailer.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to,
        subject: 'Docházka: nenahlášený příchod',
        text,
      });
    } catch (e) {
      console.error('Chyba odeslání e-mailu:', e.message);
    }
  }

  const smsTo = process.env.DISPATCHER_PHONE;
  if (twilioClient && smsTo && process.env.TWILIO_NUMBER) {
    try {
      await twilioClient.messages.create({
        from: process.env.TWILIO_NUMBER,
        to: smsTo,
        body: text,
      });
    } catch (e) {
      console.error('Chyba odeslání SMS:', e.message);
    }
  }

  if (!mailer && !twilioClient) {
    console.warn('Notifikace nenastaveny (chybí SMTP i Twilio):', text);
  }
}

// Projde směny, jejichž začátek + tolerance už uplynul, a u kterých zatím
// nepřišel příchod a ještě nebylo odesláno upozornění.
async function checkMissedShifts() {
  const { rows } = await pool.query(`
    SELECT s.id, s.starts_at, s.grace_min,
           e.name AS employee, e.id AS employee_id,
           si.name AS site
      FROM shifts s
      JOIN employees e ON e.id = s.employee_id
 LEFT JOIN sites si    ON si.id = s.site_id
     WHERE s.alerted = FALSE
       AND now() > s.starts_at + (s.grace_min || ' minutes')::interval
       AND NOT EXISTS (
             SELECT 1 FROM attendance_logs l
              WHERE l.employee_id = s.employee_id
                AND l.event_type = 'check_in'
                AND l.called_at >= s.starts_at - interval '1 hour'
                AND l.called_at <= s.starts_at + (s.grace_min || ' minutes')::interval
           )
  `);

  for (const shift of rows) {
    const when = new Date(shift.starts_at).toLocaleString('cs-CZ');
    const where = shift.site ? ` na objektu ${shift.site}` : '';
    await sendAlert(
      `Zaměstnanec ${shift.employee} se nenahlásil k příchodu${where}. Začátek směny: ${when}.`
    );
    await pool.query('UPDATE shifts SET alerted = TRUE WHERE id = $1', [shift.id]);
    console.log(`Upozornění odesláno: ${shift.employee}`);
  }
}

// Spustí hlídání každou minutu.
export function startShiftWatcher() {
  setInterval(() => {
    checkMissedShifts().catch((e) => console.error('checkMissedShifts:', e.message));
  }, 60 * 1000);
  console.log('Hlídání nenahlášených směn spuštěno (interval 60 s).');
}

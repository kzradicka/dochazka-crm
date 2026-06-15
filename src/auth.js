import jwt from 'jsonwebtoken';
import { authenticator } from 'otplib';

const SECRET = process.env.JWT_SECRET || 'zmente-me-v-promennych-prostredi';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
const TOTP_SECRET = process.env.TOTP_SECRET || ''; // base32 klíč; když prázdné, 2FA je vypnuté

// Povolíme ±1 časové okno (±30 s) kvůli drobnému rozjetí hodin v telefonu.
authenticator.options = { window: 1 };

// Je dvoufaktorové ověření zapnuté?
export function totpEnabled() {
  return !!TOTP_SECRET;
}

// Ověří heslo (a případně 6místný kód z authenticatoru) a vrátí podepsaný token.
// Vrací { token } při úspěchu, nebo { error } při chybě.
export function login(password, code) {
  if (password !== ADMIN_PASSWORD) return { error: 'Nesprávné heslo' };

  if (TOTP_SECRET) {
    const c = (code || '').toString().trim();
    if (!c) return { error: 'Zadejte ověřovací kód z aplikace', needCode: true };
    let ok = false;
    try { ok = authenticator.verify({ token: c, secret: TOTP_SECRET }); } catch { ok = false; }
    if (!ok) return { error: 'Neplatný ověřovací kód', needCode: true };
  }

  const token = jwt.sign({ role: 'dispatcher' }, SECRET, { expiresIn: '12h' });
  return { token };
}

// Middleware – chrání /api endpointy. Token se posílá v hlavičce Authorization: Bearer <token>.
export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Nepřihlášeno' });
  try {
    req.user = jwt.verify(token, SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Neplatný token' });
  }
}

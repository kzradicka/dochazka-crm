import jwt from 'jsonwebtoken';

const SECRET = process.env.JWT_SECRET || 'zmente-me-v-promennych-prostredi';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';

// Ověří heslo a vrátí podepsaný token (platnost 12 h).
export function login(password) {
  if (password !== ADMIN_PASSWORD) return null;
  return jwt.sign({ role: 'dispatcher' }, SECRET, { expiresIn: '12h' });
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

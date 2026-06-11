// Relativní cesty – frontend i API běží na stejné doméně, takže přesun
// na jinou doménu (crm.ostrahaobjektupraha.cz) nevyžaduje žádnou změnu kódu.

let token = localStorage.getItem('token') || null;

export function getToken() { return token; }
export function setToken(t) { token = t; localStorage.setItem('token', t); }
export function clearToken() { token = null; localStorage.removeItem('token'); }

async function req(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { clearToken(); window.location.reload(); return; }
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e.error || 'Chyba serveru');
  }
  return res.json();
}

export const api = {
  login: (password) => req('POST', '/api/login', { password }),
  onSite: () => req('GET', '/api/on-site'),
  attendance: (q) => req('GET', '/api/attendance?' + new URLSearchParams(q)),
  employees: () => req('GET', '/api/employees'),
  addEmployee: (d) => req('POST', '/api/employees', d),
  updateEmployee: (id, d) => req('PUT', `/api/employees/${id}`, d),
  sites: () => req('GET', '/api/sites'),
  addSite: (d) => req('POST', '/api/sites', d),
  shifts: () => req('GET', '/api/shifts'),
  addShift: (d) => req('POST', '/api/shifts', d),
};

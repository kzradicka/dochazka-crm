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
  login: (password, code) => req('POST', '/api/login', { password, code }),
  authInfo: () => req('GET', '/api/auth-info'),
  onSite: () => req('GET', '/api/on-site'),
  attendance: (q) => req('GET', '/api/attendance?' + new URLSearchParams(q)),
  updateAttendance: (id, d) => req('PUT', `/api/attendance/${id}`, d),
  deleteAttendance: (id) => req('DELETE', `/api/attendance/${id}`),
  employees: () => req('GET', '/api/employees'),
  addEmployee: (d) => req('POST', '/api/employees', d),
  updateEmployee: (id, d) => req('PUT', `/api/employees/${id}`, d),
  sites: () => req('GET', '/api/sites'),
  addSite: (d) => req('POST', '/api/sites', d),
  deleteSite: (id) => req('DELETE', `/api/sites/${id}`),
  addSitePhone: (id, phone_number) => req('POST', `/api/sites/${id}/phones`, { phone_number }),
  deleteSitePhone: (id, phoneId) => req('DELETE', `/api/sites/${id}/phones/${phoneId}`),
  shifts: () => req('GET', '/api/shifts'),
  addShift: (d) => req('POST', '/api/shifts', d),
};

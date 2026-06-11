import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { fmtDateTime } from '../format.js';

export default function Shifts() {
  const [shifts, setShifts] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [sites, setSites] = useState([]);
  const [form, setForm] = useState({ employee_id: '', site_id: '', starts_at: '', grace_min: 15 });

  const load = () => api.shifts().then(setShifts).catch(() => {});
  useEffect(() => {
    load();
    api.employees().then(setEmployees).catch(() => {});
    api.sites().then(setSites).catch(() => {});
  }, []);

  async function add() {
    if (!form.employee_id || !form.starts_at) return;
    await api.addShift(form);
    setForm({ employee_id: '', site_id: '', starts_at: '', grace_min: 15 });
    load();
  }

  return (
    <div>
      <h2>Směny a hlídání příchodů</h2>

      <div className="card">
        <p style={{ marginTop: 0, color: 'var(--muted)' }}>
          Zadejte plánovaný začátek směny. Pokud se zaměstnanec do tolerance (v minutách)
          telefonicky nenahlásí, systém automaticky upozorní dispečink e-mailem nebo SMS.
        </p>
        <div className="row-form">
          <div className="f"><label>Zaměstnanec</label>
            <select value={form.employee_id} onChange={(e) => setForm({ ...form, employee_id: e.target.value })}>
              <option value="">Vyberte…</option>
              {employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </select></div>
          <div className="f"><label>Objekt</label>
            <select value={form.site_id} onChange={(e) => setForm({ ...form, site_id: e.target.value })}>
              <option value="">—</option>
              {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select></div>
          <div className="f"><label>Začátek směny</label>
            <input type="datetime-local" value={form.starts_at}
              onChange={(e) => setForm({ ...form, starts_at: e.target.value })} /></div>
          <div className="f"><label>Tolerance (min)</label>
            <input type="number" min="0" style={{ width: 90 }} value={form.grace_min}
              onChange={(e) => setForm({ ...form, grace_min: parseInt(e.target.value || '0', 10) })} /></div>
          <button className="btn-primary" onClick={add}>Naplánovat</button>
        </div>
      </div>

      <div className="card">
        <table>
          <thead>
            <tr><th>Začátek směny</th><th>Zaměstnanec</th><th>Objekt</th><th>Tolerance</th><th>Stav</th></tr>
          </thead>
          <tbody>
            {shifts.map((s) => (
              <tr key={s.id}>
                <td>{fmtDateTime(s.starts_at)}</td>
                <td>{s.employee}</td>
                <td>{s.site || '—'}</td>
                <td>{s.grace_min} min</td>
                <td>
                  {s.alerted
                    ? <span className="badge warn">Odesláno upozornění</span>
                    : <span className="badge ok">Hlídá se</span>}
                </td>
              </tr>
            ))}
            {shifts.length === 0 && <tr><td colSpan="5" className="empty">Žádné naplánované směny.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

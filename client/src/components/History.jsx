import React, { useEffect, useState } from 'react';
import * as XLSX from 'xlsx';
import { api } from '../api.js';
import { fmtDateTime } from '../format.js';

export default function History() {
  const [rows, setRows] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [sites, setSites] = useState([]);
  const [filters, setFilters] = useState({ from: '', to: '', employee_id: '', site_id: '' });
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    api.employees().then(setEmployees).catch(() => {});
    api.sites().then(setSites).catch(() => {});
    load();
  }, []);

  async function load() {
    setLoading(true);
    const q = Object.fromEntries(Object.entries(filters).filter(([, v]) => v));
    try { setRows(await api.attendance(q)); } catch {} finally { setLoading(false); }
  }

  function exportXlsx() {
    const data = rows.map((r) => ({
      'Datum a čas': fmtDateTime(r.called_at),
      'Zaměstnanec': r.employee,
      'Osobní číslo': r.pin_code,
      'Událost': r.event_type === 'check_out' ? 'Odhlášení' : 'Přihlášení',
      'Objekt': r.site || '',
      'Telefon volajícího': r.caller_number || '',
    }));
    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Docházka');
    XLSX.writeFile(wb, `dochazka_${new Date().toISOString().slice(0, 10)}.xlsx`);
  }

  const set = (k) => (e) => setFilters({ ...filters, [k]: e.target.value });

  return (
    <div>
      <h2>Historie docházky</h2>
      <div className="card">
        <div className="filters">
          <div className="f"><label>Od</label><input type="date" value={filters.from} onChange={set('from')} /></div>
          <div className="f"><label>Do</label><input type="date" value={filters.to} onChange={set('to')} /></div>
          <div className="f">
            <label>Zaměstnanec</label>
            <select value={filters.employee_id} onChange={set('employee_id')}>
              <option value="">Všichni</option>
              {employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </select>
          </div>
          <div className="f">
            <label>Objekt</label>
            <select value={filters.site_id} onChange={set('site_id')}>
              <option value="">Všechny</option>
              {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
          <button className="btn-primary" onClick={load}>Filtrovat</button>
          <button className="btn-ghost" onClick={exportXlsx} disabled={!rows.length}>Export do Excelu</button>
        </div>

        {loading ? (
          <div className="empty">Načítám…</div>
        ) : rows.length === 0 ? (
          <div className="empty">Žádné záznamy pro zvolený filtr.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Datum a čas</th><th>Zaměstnanec</th><th>Os. číslo</th>
                <th>Událost</th><th>Objekt</th><th>Telefon</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>{fmtDateTime(r.called_at)}</td>
                  <td>{r.employee}</td>
                  <td>{r.pin_code}</td>
                  <td>
                    <span className={`badge ${r.event_type === 'check_out' ? 'out' : 'in'}`}>
                      {r.event_type === 'check_out' ? 'Odhlášení' : 'Přihlášení'}
                    </span>
                  </td>
                  <td>{r.site || '—'}</td>
                  <td>{r.caller_number || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

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

  // Inline úprava záznamu
  const [editId, setEditId] = useState(null);
  const [editVals, setEditVals] = useState({ hours: 12, site_id: '' });

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

  function startEdit(r) {
    setEditId(r.id);
    setEditVals({ hours: r.hours, site_id: r.site_id || '' });
  }
  function cancelEdit() { setEditId(null); }
  async function saveEdit(id) {
    await api.updateAttendance(id, {
      hours: Number(editVals.hours),
      site_id: editVals.site_id || null,
    });
    setEditId(null);
    load();
  }
  async function remove(id) {
    if (!window.confirm('Opravdu smazat tento záznam?')) return;
    await api.deleteAttendance(id);
    load();
  }

  function exportXlsx() {
    const data = rows.map((r) => ({
      'Datum a čas': fmtDateTime(r.called_at),
      'Zaměstnanec': r.employee,
      'Osobní číslo': r.pin_code,
      'Hodiny': r.hours,
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
                <th>Hodiny</th><th>Objekt</th><th>Telefon</th><th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                editId === r.id ? (
                  <tr key={r.id}>
                    <td>{fmtDateTime(r.called_at)}</td>
                    <td>{r.employee}</td>
                    <td>{r.pin_code}</td>
                    <td>
                      <input type="number" min="0" step="0.5" style={{ width: 70 }}
                        value={editVals.hours}
                        onChange={(e) => setEditVals({ ...editVals, hours: e.target.value })} />
                    </td>
                    <td>
                      <select value={editVals.site_id}
                        onChange={(e) => setEditVals({ ...editVals, site_id: e.target.value })}>
                        <option value="">—</option>
                        {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                      </select>
                    </td>
                    <td>{r.caller_number || '—'}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button className="btn-primary" onClick={() => saveEdit(r.id)}>Uložit</button>
                      <button className="btn-ghost" onClick={cancelEdit}>Zrušit</button>
                    </td>
                  </tr>
                ) : (
                  <tr key={r.id}>
                    <td>{fmtDateTime(r.called_at)}</td>
                    <td>{r.employee}</td>
                    <td>{r.pin_code}</td>
                    <td>{r.hours} h</td>
                    <td>{r.site || '—'}</td>
                    <td>{r.caller_number || '—'}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button className="btn-ghost" onClick={() => startEdit(r)}>Upravit</button>
                      <button className="btn-ghost" onClick={() => remove(r.id)}>Smazat</button>
                    </td>
                  </tr>
                )
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

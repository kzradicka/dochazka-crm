import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { fmtDateTime } from '../format.js';

export default function OnSite() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);

  async function load() {
    try { setRows(await api.onSite()); } catch {} finally { setLoading(false); }
  }

  useEffect(() => {
    load();
    const t = setInterval(load, 30000); // obnova každých 30 s
    return () => clearInterval(t);
  }, []);

  return (
    <div>
      <h2>Kdo je právě ve službě</h2>
      <div className="card">
        <div className="toolbar">
          <div><span className="live-dot" />Živý přehled (obnova každých 30 s) · automatické odhlášení po 12 h</div>
          <button className="btn-ghost" onClick={load}>Obnovit</button>
        </div>
        {loading ? (
          <div className="empty">Načítám…</div>
        ) : rows.length === 0 ? (
          <div className="empty">Aktuálně není nikdo přihlášený ve službě.</div>
        ) : (
          <table>
            <thead>
              <tr><th>Zaměstnanec</th><th>Os. číslo</th><th>Objekt</th><th>Přihlášen od</th><th>Automaticky odhlášen</th></tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td>{r.employee}</td>
                  <td>{r.pin_code}</td>
                  <td>{r.site || '—'}</td>
                  <td>{fmtDateTime(r.since)}</td>
                  <td>{fmtDateTime(r.until)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

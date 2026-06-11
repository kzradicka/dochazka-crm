import React, { useEffect, useState } from 'react';
import { api } from '../api.js';

export default function Employees() {
  const [employees, setEmployees] = useState([]);
  const [sites, setSites] = useState([]);
  const [emp, setEmp] = useState({ name: '', phone: '', pin_code: '' });
  const [site, setSite] = useState({ name: '', address: '', phone_number: '' });
  const [err, setErr] = useState('');

  const loadEmp = () => api.employees().then(setEmployees).catch(() => {});
  const loadSites = () => api.sites().then(setSites).catch(() => {});

  useEffect(() => { loadEmp(); loadSites(); }, []);

  async function addEmployee() {
    setErr('');
    if (!emp.name || !emp.pin_code) { setErr('Vyplňte jméno a osobní číslo.'); return; }
    try {
      await api.addEmployee(emp);
      setEmp({ name: '', phone: '', pin_code: '' });
      loadEmp();
    } catch (e) { setErr(e.message); }
  }

  async function toggleActive(e) {
    await api.updateEmployee(e.id, { ...e, active: !e.active });
    loadEmp();
  }

  async function addSite() {
    if (!site.name) return;
    await api.addSite(site);
    setSite({ name: '', address: '', phone_number: '' });
    loadSites();
  }

  return (
    <div>
      <h2>Zaměstnanci a objekty</h2>

      <div className="card">
        <h3 style={{ marginTop: 0, color: 'var(--navy)' }}>Přidat zaměstnance</h3>
        {err && <div className="err">{err}</div>}
        <div className="row-form">
          <div className="f"><label>Jméno</label>
            <input value={emp.name} onChange={(e) => setEmp({ ...emp, name: e.target.value })} /></div>
          <div className="f"><label>Telefon (pro ověření)</label>
            <input value={emp.phone} placeholder="+420…" onChange={(e) => setEmp({ ...emp, phone: e.target.value })} /></div>
          <div className="f"><label>Osobní číslo (PIN)</label>
            <input value={emp.pin_code} onChange={(e) => setEmp({ ...emp, pin_code: e.target.value })} /></div>
          <button className="btn-primary" onClick={addEmployee}>Přidat</button>
        </div>
      </div>

      <div className="card">
        <table>
          <thead>
            <tr><th>Jméno</th><th>Os. číslo</th><th>Telefon</th><th>Stav</th><th></th></tr>
          </thead>
          <tbody>
            {employees.map((e) => (
              <tr key={e.id}>
                <td>{e.name}</td>
                <td>{e.pin_code}</td>
                <td>{e.phone || '—'}</td>
                <td>
                  <span className={`badge ${e.active ? 'ok' : 'warn'}`}>
                    {e.active ? 'Aktivní' : 'Neaktivní'}
                  </span>
                </td>
                <td>
                  <button className="btn-ghost" onClick={() => toggleActive(e)}>
                    {e.active ? 'Deaktivovat' : 'Aktivovat'}
                  </button>
                </td>
              </tr>
            ))}
            {employees.length === 0 && <tr><td colSpan="5" className="empty">Zatím žádní zaměstnanci.</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0, color: 'var(--navy)' }}>Objekty</h3>
        <div className="row-form" style={{ marginBottom: 16 }}>
          <div className="f"><label>Název</label>
            <input value={site.name} onChange={(e) => setSite({ ...site, name: e.target.value })} /></div>
          <div className="f"><label>Adresa</label>
            <input value={site.address} onChange={(e) => setSite({ ...site, address: e.target.value })} /></div>
          <div className="f"><label>Tel. číslo linky (volitelné)</label>
            <input value={site.phone_number} placeholder="+420…" onChange={(e) => setSite({ ...site, phone_number: e.target.value })} /></div>
          <button className="btn-primary" onClick={addSite}>Přidat objekt</button>
        </div>
        <table>
          <thead><tr><th>Název</th><th>Adresa</th><th>Tel. linka</th></tr></thead>
          <tbody>
            {sites.map((s) => (
              <tr key={s.id}><td>{s.name}</td><td>{s.address || '—'}</td><td>{s.phone_number || '—'}</td></tr>
            ))}
            {sites.length === 0 && <tr><td colSpan="3" className="empty">Zatím žádné objekty.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

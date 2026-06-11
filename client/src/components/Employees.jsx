import React, { useEffect, useState } from 'react';
import { api } from '../api.js';

export default function Employees() {
  const [employees, setEmployees] = useState([]);
  const [sites, setSites] = useState([]);
  const [emp, setEmp] = useState({ name: '', phone: '', pin_code: '' });
  const [site, setSite] = useState({ name: '', address: '', phone_number: '' });
  const [err, setErr] = useState('');

  // Stav inline úpravy: id právě upravovaného zaměstnance + rozpracované hodnoty
  const [editId, setEditId] = useState(null);
  const [editVals, setEditVals] = useState({ name: '', phone: '', pin_code: '' });
  const [editErr, setEditErr] = useState('');

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

  function startEdit(e) {
    setEditErr('');
    setEditId(e.id);
    setEditVals({ name: e.name, phone: e.phone || '', pin_code: e.pin_code });
  }
  function cancelEdit() { setEditId(null); setEditErr(''); }

  async function saveEdit(e) {
    setEditErr('');
    if (!editVals.name || !editVals.pin_code) { setEditErr('Jméno a osobní číslo nesmí být prázdné.'); return; }
    try {
      await api.updateEmployee(e.id, { ...editVals, active: e.active });
      setEditId(null);
      loadEmp();
    } catch (err) { setEditErr(err.message); }
  }

  async function toggleActive(e) {
    await api.updateEmployee(e.id, {
      name: e.name, phone: e.phone, pin_code: e.pin_code, active: !e.active,
    });
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
          <div className="f"><label>Telefon (volitelné)</label>
            <input value={emp.phone} placeholder="+420…" onChange={(e) => setEmp({ ...emp, phone: e.target.value })} /></div>
          <div className="f"><label>Osobní číslo (PIN)</label>
            <input value={emp.pin_code} onChange={(e) => setEmp({ ...emp, pin_code: e.target.value })} /></div>
          <button className="btn-primary" onClick={addEmployee}>Přidat</button>
        </div>
      </div>

      <div className="card">
        {editErr && <div className="err">{editErr}</div>}
        <table>
          <thead>
            <tr><th>Jméno</th><th>Os. číslo</th><th>Telefon</th><th>Stav</th><th></th></tr>
          </thead>
          <tbody>
            {employees.map((e) => (
              editId === e.id ? (
                <tr key={e.id}>
                  <td><input value={editVals.name}
                    onChange={(ev) => setEditVals({ ...editVals, name: ev.target.value })} /></td>
                  <td><input value={editVals.pin_code} style={{ width: 90 }}
                    onChange={(ev) => setEditVals({ ...editVals, pin_code: ev.target.value })} /></td>
                  <td><input value={editVals.phone} placeholder="+420…"
                    onChange={(ev) => setEditVals({ ...editVals, phone: ev.target.value })} /></td>
                  <td>
                    <span className={`badge ${e.active ? 'ok' : 'warn'}`}>
                      {e.active ? 'Aktivní' : 'Neaktivní'}
                    </span>
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button className="btn-primary" onClick={() => saveEdit(e)}>Uložit</button>
                    <button className="btn-ghost" onClick={cancelEdit}>Zrušit</button>
                  </td>
                </tr>
              ) : (
                <tr key={e.id}>
                  <td>{e.name}</td>
                  <td>{e.pin_code}</td>
                  <td>{e.phone || '—'}</td>
                  <td>
                    <span className={`badge ${e.active ? 'ok' : 'warn'}`}>
                      {e.active ? 'Aktivní' : 'Neaktivní'}
                    </span>
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button className="btn-ghost" onClick={() => startEdit(e)}>Upravit</button>
                    <button className="btn-ghost" onClick={() => toggleActive(e)}>
                      {e.active ? 'Deaktivovat' : 'Aktivovat'}
                    </button>
                  </td>
                </tr>
              )
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

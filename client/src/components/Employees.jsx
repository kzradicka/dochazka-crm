import React, { useEffect, useState } from 'react';
import { api } from '../api.js';

export default function Employees() {
  const [employees, setEmployees] = useState([]);
  const [sites, setSites] = useState([]);
  const [emp, setEmp] = useState({ name: '', phone: '', pin_code: '', shift_hours: 12 });
  const [site, setSite] = useState({ name: '', address: '' });
  const [err, setErr] = useState('');
  const [phoneInputs, setPhoneInputs] = useState({}); // {siteId: "rozepsané číslo"}
  const [phoneErr, setPhoneErr] = useState('');

  // Stav inline úpravy: id právě upravovaného zaměstnance + rozpracované hodnoty
  const [editId, setEditId] = useState(null);
  const [editVals, setEditVals] = useState({ name: '', phone: '', pin_code: '', shift_hours: 12 });
  const [editErr, setEditErr] = useState('');

  const loadEmp = () => api.employees().then(setEmployees).catch(() => {});
  const loadSites = () => api.sites().then(setSites).catch(() => {});

  useEffect(() => { loadEmp(); loadSites(); }, []);

  async function addEmployee() {
    setErr('');
    if (!emp.name || !emp.pin_code) { setErr('Vyplňte jméno a osobní číslo.'); return; }
    try {
      await api.addEmployee(emp);
      setEmp({ name: '', phone: '', pin_code: '', shift_hours: 12 });
      loadEmp();
    } catch (e) { setErr(e.message); }
  }

  function startEdit(e) {
    setEditErr('');
    setEditId(e.id);
    setEditVals({ name: e.name, phone: e.phone || '', pin_code: e.pin_code, shift_hours: e.shift_hours || 12 });
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
      name: e.name, phone: e.phone, pin_code: e.pin_code, shift_hours: e.shift_hours, active: !e.active,
    });
    loadEmp();
  }

  async function addSite() {
    if (!site.name) return;
    await api.addSite(site);
    setSite({ name: '', address: '' });
    loadSites();
  }
  async function deleteSite(id) {
    if (!window.confirm('Smazat objekt včetně jeho čísel?')) return;
    await api.deleteSite(id);
    loadSites();
  }
  async function addPhone(siteId) {
    setPhoneErr('');
    const num = (phoneInputs[siteId] || '').trim();
    if (!num) return;
    try {
      await api.addSitePhone(siteId, num);
      setPhoneInputs({ ...phoneInputs, [siteId]: '' });
      loadSites();
    } catch (e) { setPhoneErr(e.message); }
  }
  async function removePhone(siteId, phoneId) {
    await api.deleteSitePhone(siteId, phoneId);
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
          <div className="f"><label>Směna (hod)</label>
            <input type="number" min="1" max="12" style={{ width: 90 }} value={emp.shift_hours}
              onChange={(e) => setEmp({ ...emp, shift_hours: e.target.value })} /></div>
          <button className="btn-primary" onClick={addEmployee}>Přidat</button>
        </div>
      </div>

      <div className="card">
        {editErr && <div className="err">{editErr}</div>}
        <table>
          <thead>
            <tr><th>Jméno</th><th>Os. číslo</th><th>Telefon</th><th>Směna</th><th>Stav</th><th></th></tr>
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
                  <td><input type="number" min="1" max="12" style={{ width: 70 }} value={editVals.shift_hours}
                    onChange={(ev) => setEditVals({ ...editVals, shift_hours: ev.target.value })} /></td>
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
                  <td>{e.shift_hours} h</td>
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
            {employees.length === 0 && <tr><td colSpan="6" className="empty">Zatím žádní zaměstnanci.</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0, color: 'var(--navy)' }}>Objekty</h3>
        <p style={{ color: 'var(--muted)', marginTop: 0 }}>
          Ke každému objektu přiřaďte telefonní čísla, ze kterých se na něm hlásí.
          Číslo, ze kterého zaměstnanec volá, určí, na kterém objektu je. Z nepřiřazeného čísla se hlásit nelze.
        </p>
        <div className="row-form" style={{ marginBottom: 16 }}>
          <div className="f"><label>Název</label>
            <input value={site.name} onChange={(e) => setSite({ ...site, name: e.target.value })} /></div>
          <div className="f"><label>Adresa</label>
            <input value={site.address} onChange={(e) => setSite({ ...site, address: e.target.value })} /></div>
          <button className="btn-primary" onClick={addSite}>Přidat objekt</button>
        </div>
        {phoneErr && <div className="err">{phoneErr}</div>}

        {sites.length === 0 && <div className="empty">Zatím žádné objekty.</div>}
        {sites.map((s) => (
          <div key={s.id} style={{ borderTop: '1px solid var(--line)', padding: '12px 0' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <div>
                <strong>{s.name}</strong>
                {s.address && <span style={{ color: 'var(--muted)' }}> · {s.address}</span>}
              </div>
              <button className="btn-ghost" onClick={() => deleteSite(s.id)}>Smazat objekt</button>
            </div>
            <div style={{ margin: '8px 0', display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {(s.phones || []).length === 0 && (
                <span style={{ color: 'var(--muted)', fontSize: 13 }}>Žádná čísla – zatím se na tento objekt nelze hlásit.</span>
              )}
              {(s.phones || []).map((p) => (
                <span key={p.id} className="badge ok" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  {p.phone_number}
                  <span style={{ cursor: 'pointer', fontWeight: 700 }}
                    onClick={() => removePhone(s.id, p.id)}>×</span>
                </span>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <input placeholder="+420…" style={{ width: 180 }}
                value={phoneInputs[s.id] || ''}
                onChange={(e) => setPhoneInputs({ ...phoneInputs, [s.id]: e.target.value })}
                onKeyDown={(e) => e.key === 'Enter' && addPhone(s.id)} />
              <button className="btn-ghost" onClick={() => addPhone(s.id)}>Přidat číslo</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

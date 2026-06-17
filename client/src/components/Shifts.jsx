import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { fmtDateTime } from '../format.js';

const DAYS = [['1', 'Po'], ['2', 'Út'], ['3', 'St'], ['4', 'Čt'], ['5', 'Pá'], ['6', 'So'], ['7', 'Ne']];
const DAY_MAP = { 1: 'Po', 2: 'Út', 3: 'St', 4: 'Čt', 5: 'Pá', 6: 'So', 7: 'Ne' };

function dowText(dow) {
  if (!dow || dow.length === 7) return 'denně';
  return dow.split('').sort().map((d) => DAY_MAP[d]).join(', ');
}

export default function Shifts() {
  const [sites, setSites] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [site, setSite] = useState({ name: '', address: '' });
  const [err, setErr] = useState('');

  const [timeInputs, setTimeInputs] = useState({});   // {siteId: 'HH:MM'}
  const [dowInputs, setDowInputs] = useState({});      // {siteId: '12345'}
  const [contactInputs, setContactInputs] = useState({}); // {siteId: '+420…'}

  const loadSites = () => api.sites().then(setSites).catch(() => {});
  const loadAlerts = () => api.scheduleAlerts().then(setAlerts).catch(() => {});
  useEffect(() => { loadSites(); loadAlerts(); }, []);

  const getDow = (siteId) => (dowInputs[siteId] ?? '1234567');

  function toggleDow(siteId, d) {
    const set = new Set(getDow(siteId).split(''));
    if (set.has(d)) set.delete(d); else set.add(d);
    setDowInputs({ ...dowInputs, [siteId]: [...set].sort().join('') });
  }

  async function addSite() {
    setErr('');
    if (!site.name) { setErr('Zadejte název pobočky.'); return; }
    try {
      await api.addSite(site);
      setSite({ name: '', address: '' });
      loadSites();
    } catch (e) { setErr(e.message); }
  }
  async function deleteSite(id) {
    if (!window.confirm('Smazat pobočku včetně časů, čísel a kontaktů?')) return;
    await api.deleteSite(id);
    loadSites();
  }

  async function addTime(siteId) {
    setErr('');
    const t = timeInputs[siteId];
    if (!t) { setErr('Zadejte čas příchodu.'); return; }
    const dow = getDow(siteId);
    if (!dow) { setErr('Vyberte aspoň jeden den.'); return; }
    try {
      await api.addSchedule(siteId, { expected_time: t, dow });
      setTimeInputs({ ...timeInputs, [siteId]: '' });
      setDowInputs({ ...dowInputs, [siteId]: '1234567' });
      loadSites();
    } catch (e) { setErr(e.message); }
  }
  async function deleteTime(id) {
    await api.deleteSchedule(id);
    loadSites();
  }

  async function addContact(siteId) {
    setErr('');
    const num = (contactInputs[siteId] || '').trim();
    if (!num) return;
    try {
      await api.addContact(siteId, num);
      setContactInputs({ ...contactInputs, [siteId]: '' });
      loadSites();
    } catch (e) { setErr(e.message); }
  }
  async function deleteContact(id) {
    await api.deleteContact(id);
    loadSites();
  }

  return (
    <div>
      <h2>Směny a hlídání příchodů</h2>

      <div className="card">
        <p style={{ marginTop: 0, color: 'var(--muted)' }}>
          U každé pobočky nastavte očekávané časy příchodu a dny, kdy platí. Pokud se na pobočce
          nikdo nenahlásí osobním kódem, systém po <strong>10 minutách</strong> zavolá na čísla
          pobočky a po <strong>15 minutách</strong> na kontaktní čísla (automat přehraje hlášku).
        </p>
        {err && <div className="err">{err}</div>}
        <div className="row-form">
          <div className="f"><label>Název pobočky</label>
            <input value={site.name} onChange={(e) => setSite({ ...site, name: e.target.value })} /></div>
          <div className="f"><label>Adresa (volitelné)</label>
            <input value={site.address} onChange={(e) => setSite({ ...site, address: e.target.value })} /></div>
          <button className="btn-primary" onClick={addSite}>Přidat pobočku</button>
        </div>
      </div>

      {sites.length === 0 && <div className="card"><div className="empty">Zatím žádné pobočky.</div></div>}

      {sites.map((s) => (
        <div key={s.id} className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <h3 style={{ margin: 0, color: 'var(--navy)' }}>
              {s.name}{s.address && <span style={{ color: 'var(--muted)', fontWeight: 400 }}> · {s.address}</span>}
            </h3>
            <button className="btn-ghost" onClick={() => deleteSite(s.id)}>Smazat pobočku</button>
          </div>

          {/* Očekávané časy příchodu */}
          <div style={{ marginTop: 12 }}>
            <strong>Očekávané příchody</strong>
            <div style={{ margin: '8px 0', display: 'flex', flexDirection: 'column', gap: 6 }}>
              {(s.schedules || []).length === 0 && (
                <span style={{ color: 'var(--muted)', fontSize: 13 }}>Žádné časy – tato pobočka se zatím nehlídá.</span>
              )}
              {(s.schedules || []).map((sc) => (
                <span key={sc.id} className="badge ok" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, width: 'fit-content' }}>
                  <strong>{sc.expected_time}</strong> · {dowText(sc.dow)}
                  <span style={{ cursor: 'pointer', fontWeight: 700 }} onClick={() => deleteTime(sc.id)}>×</span>
                </span>
              ))}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
              <input type="time" style={{ width: 120 }}
                value={timeInputs[s.id] || ''}
                onChange={(e) => setTimeInputs({ ...timeInputs, [s.id]: e.target.value })} />
              <div style={{ display: 'flex', gap: 4 }}>
                {DAYS.map(([d, label]) => {
                  const on = getDow(s.id).includes(d);
                  return (
                    <span key={d} onClick={() => toggleDow(s.id, d)}
                      className={`badge ${on ? 'ok' : 'warn'}`}
                      style={{ cursor: 'pointer', userSelect: 'none' }}>{label}</span>
                  );
                })}
              </div>
              <button className="btn-ghost" onClick={() => addTime(s.id)}>Přidat čas</button>
            </div>
          </div>

          {/* Čísla pobočky – 1. hovor (+10 min) */}
          <div style={{ marginTop: 16 }}>
            <strong>Telefon pobočky</strong>{' '}
            <span style={{ color: 'var(--muted)', fontSize: 13 }}>(hovor po 10 min; čísla se spravují v záložce „Zaměstnanci a objekty")</span>
            <div style={{ margin: '8px 0', display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {(s.phones || []).length === 0 && (
                <span style={{ color: 'var(--muted)', fontSize: 13 }}>Žádná čísla pobočky.</span>
              )}
              {(s.phones || []).map((p) => (
                <span key={p.id} className="badge ok">{p.phone_number}</span>
              ))}
            </div>
          </div>

          {/* Kontaktní (emergency) čísla – 2. hovor (+15 min) */}
          <div style={{ marginTop: 12 }}>
            <strong>Kontaktní čísla pro eskalaci</strong>{' '}
            <span style={{ color: 'var(--muted)', fontSize: 13 }}>(hovor po 15 min)</span>
            <div style={{ margin: '8px 0', display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {(s.contacts || []).length === 0 && (
                <span style={{ color: 'var(--muted)', fontSize: 13 }}>Žádná kontaktní čísla.</span>
              )}
              {(s.contacts || []).map((c) => (
                <span key={c.id} className="badge ok" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  {c.phone_number}
                  <span style={{ cursor: 'pointer', fontWeight: 700 }} onClick={() => deleteContact(c.id)}>×</span>
                </span>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <input placeholder="+420…" style={{ width: 180 }}
                value={contactInputs[s.id] || ''}
                onChange={(e) => setContactInputs({ ...contactInputs, [s.id]: e.target.value })}
                onKeyDown={(e) => e.key === 'Enter' && addContact(s.id)} />
              <button className="btn-ghost" onClick={() => addContact(s.id)}>Přidat kontakt</button>
            </div>
          </div>
        </div>
      ))}

      {/* Poslední odeslaná upozornění */}
      <div className="card">
        <h3 style={{ marginTop: 0, color: 'var(--navy)' }}>Poslední upozornění</h3>
        <table>
          <thead>
            <tr><th>Kdy</th><th>Pobočka</th><th>Očekáván příchod</th><th>Typ</th></tr>
          </thead>
          <tbody>
            {alerts.map((a) => (
              <tr key={a.id}>
                <td>{fmtDateTime(a.sent_at)}</td>
                <td>{a.site}</td>
                <td>{a.expected_time}</td>
                <td>
                  <span className={`badge ${a.level === 2 ? 'warn' : 'ok'}`}>
                    {a.level === 2 ? 'Hovor kontakty (+15 min)' : 'Hovor pobočka (+10 min)'}
                  </span>
                </td>
              </tr>
            ))}
            {alerts.length === 0 && <tr><td colSpan="4" className="empty">Zatím žádná upozornění.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

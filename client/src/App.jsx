import React, { useState, useEffect } from 'react';
import { api, getToken, setToken, clearToken } from './api.js';
import Login from './components/Login.jsx';
import OnSite from './components/OnSite.jsx';
import History from './components/History.jsx';
import Employees from './components/Employees.jsx';
import Shifts from './components/Shifts.jsx';

const TABS = [
  { id: 'live', label: 'Kdo je ve službě', C: OnSite },
  { id: 'history', label: 'Historie docházky', C: History },
  { id: 'employees', label: 'Zaměstnanci a objekty', C: Employees },
  { id: 'shifts', label: 'Směny a hlídání', C: Shifts },
];

/* Přepínač zobrazení: automaticky podle šířky okna, nebo ručně.
   Volba se ukládá na zařízení (localStorage). */
const VIEWS = [
  { id: 'auto',    title: 'Automaticky podle okna' },
  { id: 'mobile',  title: 'Telefon' },
  { id: 'tablet',  title: 'Tablet' },
  { id: 'desktop', title: 'Počítač' },
];

function ViewIcon({ id }) {
  const p = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' };
  if (id === 'mobile') {
    return <svg viewBox="0 0 24 24" {...p}><rect x="7" y="2.5" width="10" height="19" rx="2" /><path d="M11 18.5h2" /></svg>;
  }
  if (id === 'tablet') {
    return <svg viewBox="0 0 24 24" {...p}><rect x="4.5" y="2.5" width="15" height="19" rx="2" /><path d="M11 18.5h2" /></svg>;
  }
  if (id === 'desktop') {
    return <svg viewBox="0 0 24 24" {...p}><rect x="2.5" y="4" width="19" height="12.5" rx="1.6" /><path d="M8.5 20.5h7M12 16.5v4" /></svg>;
  }
  return <svg viewBox="0 0 24 24" {...p}><rect x="2.5" y="5" width="14" height="10.5" rx="1.6" /><path d="M7 19.5h5M9.5 15.5v4" /><rect x="17" y="11" width="4.5" height="8.5" rx="1.2" /></svg>;
}

export default function App() {
  const [authed, setAuthed] = useState(!!getToken());
  const [tab, setTab] = useState('live');
  const [view, setView] = useState(() => localStorage.getItem('view') || 'auto');
  const [notif, setNotif] = useState(
    typeof Notification !== 'undefined' ? Notification.permission : 'unsupported'
  );

  useEffect(() => { localStorage.setItem('view', view); }, [view]);

  async function enableNotifications() {
    if (typeof Notification === 'undefined') return;
    try {
      const res = await Notification.requestPermission();
      setNotif(res);
    } catch { /* uživatel dialog zavřel */ }
  }

  if (!authed) {
    return <Login onSuccess={(t) => { setToken(t); setAuthed(true); }} />;
  }

  const Active = TABS.find((t) => t.id === tab).C;

  return (
    <div className={`app view-${view}`}>
      <aside className="sidebar">
        <div className="brand">
          <img className="brand-logo" src="/icons/logo-bh.png" alt="B+H" />
          <div className="brand-text">
            <span className="brand-title">CRM</span>
            <span className="brand-sub">DOCHÁZKOVÝ SYSTÉM</span>
          </div>
        </div>

        <nav>
          {TABS.map((t) => (
            <a key={t.id} className={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)}>
              {t.label}
            </a>
          ))}
        </nav>

        <div className="side-foot">
          <div className="view-switch" role="group" aria-label="Zobrazení">
            {VIEWS.map((v) => (
              <button
                key={v.id}
                type="button"
                title={v.title}
                aria-label={v.title}
                aria-pressed={view === v.id}
                className={view === v.id ? 'active' : ''}
                onClick={() => setView(v.id)}
              >
                <ViewIcon id={v.id} />
              </button>
            ))}
          </div>

          {notif !== 'unsupported' && (
            notif === 'granted' ? (
              <span className="side-link is-on">Upozornění zapnuta</span>
            ) : notif === 'denied' ? (
              <span className="side-link is-off">Upozornění blokována</span>
            ) : (
              <a className="side-link" onClick={enableNotifications}>Zapnout upozornění</a>
            )
          )}

          <a className="side-link" onClick={() => { clearToken(); setAuthed(false); }}>
            Odhlásit se
          </a>
        </div>
      </aside>

      <main className="main">
        <Active />
      </main>
    </div>
  );
}

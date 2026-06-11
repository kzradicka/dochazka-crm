import React, { useState } from 'react';
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

export default function App() {
  const [authed, setAuthed] = useState(!!getToken());
  const [tab, setTab] = useState('live');

  if (!authed) {
    return <Login onSuccess={(t) => { setToken(t); setAuthed(true); }} />;
  }

  const Active = TABS.find((t) => t.id === tab).C;

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">Docházka · ostraha</div>
        <nav>
          {TABS.map((t) => (
            <a key={t.id} className={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)}>
              {t.label}
            </a>
          ))}
        </nav>
        <div className="logout" onClick={() => { clearToken(); setAuthed(false); }}>
          Odhlásit se
        </div>
      </aside>
      <main className="main">
        <Active />
      </main>
    </div>
  );
}

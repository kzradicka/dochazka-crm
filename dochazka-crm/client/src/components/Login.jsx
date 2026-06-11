import React, { useState } from 'react';
import { api } from '../api.js';

export default function Login({ onSuccess }) {
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    setErr(''); setBusy(true);
    try {
      const { token } = await api.login(password);
      onSuccess(token);
    } catch (e) {
      setErr('Nesprávné heslo');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <div className="login-card">
        <h1>Docházkový systém</h1>
        <p>Přihlášení dispečinku</p>
        {err && <div className="err">{err}</div>}
        <input
          type="password"
          placeholder="Heslo"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          autoFocus
        />
        <button className="btn-primary" onClick={submit} disabled={busy}>
          {busy ? 'Přihlašuji…' : 'Přihlásit se'}
        </button>
      </div>
    </div>
  );
}

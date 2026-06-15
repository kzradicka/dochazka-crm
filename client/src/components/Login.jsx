import React, { useState, useEffect } from 'react';
import { api } from '../api.js';

export default function Login({ onSuccess }) {
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [totp, setTotp] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.authInfo().then((i) => setTotp(i.totp)).catch(() => {});
  }, []);

  async function submit() {
    setErr(''); setBusy(true);
    try {
      const { token } = await api.login(password, code);
      onSuccess(token);
    } catch (e) {
      setErr(e.message || 'Přihlášení se nezdařilo');
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
        {totp && (
          <input
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="Kód z aplikace (6 číslic)"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
          />
        )}
        <button className="btn-primary" onClick={submit} disabled={busy}>
          {busy ? 'Přihlašuji…' : 'Přihlásit se'}
        </button>
      </div>
    </div>
  );
}

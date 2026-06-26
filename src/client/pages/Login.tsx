import { useState, type FormEvent } from 'react';
import { useNavigate, useLocation, Navigate } from 'react-router-dom';
import { useAuth } from '../lib/auth.tsx';

export function LoginPage() {
  const { user, login } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (user) return <Navigate to="/" replace />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await login(username, password);
      const from = (loc.state as { from?: string } | null)?.from;
      nav(from || '/', { replace: true });
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : 'login failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="content" style={{ maxWidth: 380, marginTop: '12vh' }}>
      <div className="row" style={{ justifyContent: 'center', marginBottom: 18 }}>
        <span className="brand-dot" style={{ width: 30, height: 30 }} />
        <h1 style={{ margin: 0 }}>StorAlex</h1>
      </div>
      <form className="card" onSubmit={submit}>
        <div className="field">
          <label htmlFor="u">Username</label>
          <input id="u" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoFocus />
        </div>
        <div className="field">
          <label htmlFor="p">Password</label>
          <input
            id="p"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </div>
        {err && <p className="error">{err}</p>}
        <button className="btn primary block" disabled={busy || !username || !password}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}

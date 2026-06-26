import { useState, type FormEvent } from 'react';
import { useNavigate, useLocation, Navigate } from 'react-router-dom';
import { useAuth } from '../lib/auth.tsx';
import { useSetupNeeded } from '../lib/queries.ts';
import { Spinner } from '../components/ui.tsx';

export function LoginPage() {
  const { user, login, setup } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const setupNeeded = useSetupNeeded();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (user) return <Navigate to="/" replace />;

  const isSetup = setupNeeded.data?.needed === true;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      if (isSetup) await setup(username, password);
      else await login(username, password);
      const from = (loc.state as { from?: string } | null)?.from;
      nav(from || '/', { replace: true });
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : isSetup ? 'setup failed' : 'login failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-screen">
      <div style={{ width: '100%', maxWidth: 380 }}>
        <div className="row" style={{ justifyContent: 'center', marginBottom: 18 }}>
          <span className="brand-dot" style={{ width: 30, height: 30 }} />
          <h1 style={{ margin: 0 }}>StorAlex</h1>
        </div>
        {setupNeeded.isLoading ? (
          <Spinner />
        ) : (
          <form className="card" onSubmit={submit}>
            {isSetup && (
              <p className="small muted" style={{ marginTop: 0 }}>
                Welcome — create the first account to get started.
              </p>
            )}
            <div className="field">
              <label htmlFor="u">Username</label>
              <input
                id="u"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                autoFocus
              />
            </div>
            <div className="field">
              <label htmlFor="p">Password{isSetup ? ' (min 8 characters)' : ''}</label>
              <input
                id="p"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={isSetup ? 'new-password' : 'current-password'}
              />
            </div>
            {err && <p className="error">{err}</p>}
            <button
              className="btn primary block"
              disabled={busy || !username || !password || (isSetup && password.length < 8)}
            >
              {busy ? 'Please wait…' : isSetup ? 'Create account' : 'Sign in'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

import { useState, type FormEvent } from 'react';
import { useUsers, useCreateUser, useDeleteUser, useChangePassword } from '../lib/queries.ts';
import { useAuth } from '../lib/auth.tsx';
import { Spinner, ErrorMsg } from '../components/ui.tsx';

export function UsersPage() {
  const { user: me } = useAuth();
  const users = useUsers();
  const createUser = useCreateUser();
  const deleteUser = useDeleteUser();
  const changePw = useChangePassword();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [pwFor, setPwFor] = useState<number | null>(null);
  const [newPw, setNewPw] = useState('');

  async function add(e: FormEvent) {
    e.preventDefault();
    await createUser.mutateAsync({ username: username.trim(), password });
    setUsername('');
    setPassword('');
  }

  async function savePw(id: number) {
    await changePw.mutateAsync({ id, password: newPw });
    setPwFor(null);
    setNewPw('');
  }

  const onlyOne = (users.data?.length ?? 0) <= 1;

  return (
    <div className="col">
      <h2 style={{ margin: 0 }}>Users</h2>
      <p className="small muted">Anyone here can add or remove users and reset passwords.</p>

      <form className="card" onSubmit={add}>
        <div className="field">
          <label htmlFor="nu">New username</label>
          <input id="nu" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" />
        </div>
        <div className="field">
          <label htmlFor="np">Password (min 8)</label>
          <input
            id="np"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
          />
        </div>
        <ErrorMsg error={createUser.error} />
        <button className="btn primary block" disabled={createUser.isPending || !username.trim() || password.length < 8}>
          {createUser.isPending ? 'Adding…' : 'Add user'}
        </button>
      </form>

      {users.isLoading && <Spinner />}
      <ErrorMsg error={users.error || deleteUser.error || changePw.error} />

      {users.data?.map((u) => (
        <div key={u.id} className="card">
          <div className="row">
            <div className="grow">
              <b>{u.username}</b>
              {u.id === me?.id && <span className="small muted"> (you)</span>}
              <div className="small muted">last login: {u.last_login_at ?? 'never'}</div>
            </div>
            <button
              className="btn"
              style={{ minHeight: 32, padding: '4px 10px' }}
              onClick={() => {
                setPwFor(pwFor === u.id ? null : u.id);
                setNewPw('');
              }}
            >
              Password
            </button>
            <button
              className="btn danger"
              style={{ minHeight: 32, padding: '4px 10px' }}
              disabled={onlyOne}
              onClick={() => {
                if (window.confirm(`Delete user "${u.username}"?`)) deleteUser.mutate(u.id);
              }}
            >
              Delete
            </button>
          </div>
          {pwFor === u.id && (
            <div className="row" style={{ marginTop: 10 }}>
              <input
                className="grow"
                type="password"
                placeholder="New password (min 8)"
                value={newPw}
                onChange={(e) => setNewPw(e.target.value)}
                style={{ padding: 10, borderRadius: 10, background: 'var(--bg)', border: '1px solid var(--border)', color: 'var(--text)' }}
              />
              <button className="btn primary" onClick={() => savePw(u.id)} disabled={newPw.length < 8 || changePw.isPending}>
                Save
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

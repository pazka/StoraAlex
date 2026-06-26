import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../lib/auth.tsx';

const navClass = ({ isActive }: { isActive: boolean }) => (isActive ? 'active' : '');

export function Layout() {
  const { user, logout } = useAuth();
  return (
    <div className="app">
      <header className="topbar">
        <span className="brand-dot" />
        <h1>StorAlex</h1>
        <span className="spacer" />
        {user && (
          <button className="btn" style={{ minHeight: 36, padding: '6px 12px' }} onClick={() => void logout()}>
            Logout
          </button>
        )}
      </header>
      <main className="content">
        <Outlet />
      </main>
      <nav className="bottomnav">
        <NavLink to="/" end className={navClass}>
          <span className="ico">⌖</span>Scan
        </NavLink>
        <NavLink to="/items" className={navClass}>
          <span className="ico">📦</span>Items
        </NavLink>
        <NavLink to="/places" className={navClass}>
          <span className="ico">🗄️</span>Places
        </NavLink>
        <NavLink to="/tags" className={navClass}>
          <span className="ico">🏷️</span>Tags
        </NavLink>
        <NavLink to="/labels" className={navClass}>
          <span className="ico">🖨️</span>Labels
        </NavLink>
      </nav>
    </div>
  );
}

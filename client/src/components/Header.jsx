import { navigate, useRoute } from '../router.js';
import { openSignIn, useBoard, useEngine } from '../useEngine.js';
import { BrandMark } from './icons.jsx';

export function Header() {
  const engine = useEngine();
  const route = useRoute();
  const auth = useBoard((s) => s.auth);
  const instanceId = useBoard((s) => s.instanceId);
  const debug = useBoard((s) => s.debug);

  return (
    <header className="site-nav" role="banner">
      <div className="site-nav-inner">
        <a
          href="/"
          className="brand"
          onClick={(e) => {
            e.preventDefault();
            navigate('/');
          }}
        >
          <BrandMark />
          <span className="brand-title">million/boxes</span>
          {debug && instanceId && <span className="instance-badge mono">{instanceId}</span>}
        </a>

        <nav className="site-nav-links" aria-label="Primary">
          <a
            href="/grid"
            className={`nav-link${route === '/grid' ? ' active' : ''}`}
            onClick={(e) => {
              e.preventDefault();
              navigate('/grid');
            }}
          >
            GRID
          </a>
          <a
            href="/#architecture"
            className="nav-link desktop-only"
            onClick={(e) => {
              e.preventDefault();
              navigate('/#architecture');
            }}
          >
            ARCHITECTURE
          </a>
          <a
            href="/#features"
            className="nav-link desktop-only"
            onClick={(e) => {
              e.preventDefault();
              navigate('/#features');
            }}
          >
            FEATURES
          </a>
        </nav>

        <div className="site-nav-actions">
          {auth.authenticated && auth.user ? (
            <div className="nav-auth-signed">
              <span className="nav-user-pill mono" title="Signed in">
                <span className="live-dot" aria-hidden="true" />
                <span className="nav-user-name">{auth.user.name}</span>
              </span>
              <button type="button" className="nav-signin-link" onClick={() => engine.logout()}>
                Sign out
              </button>
            </div>
          ) : (
            <button type="button" className="nav-signin-link" onClick={() => openSignIn(engine)}>
              Sign in
            </button>
          )}

          <a
            href="/grid"
            className="nav-open-grid"
            onClick={(e) => {
              e.preventDefault();
              navigate('/grid');
            }}
          >
            <span>Open grid</span>
            <span aria-hidden="true">→</span>
          </a>
        </div>
      </div>
    </header>
  );
}

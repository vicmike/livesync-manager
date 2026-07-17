import { useEffect, useState } from 'react';
import { api, type Session } from './api.js';
import { LoginPage, SetupPage } from './pages/AuthPages.js';
import { Dashboard } from './pages/Dashboard.js';
import { VaultDetailPage } from './pages/VaultDetail.js';

type AuthState = 'loading' | 'setup' | 'login' | 'ready';

function useHashRoute(): string {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const onChange = () => setHash(location.hash);
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return hash;
}

export function App() {
  const [auth, setAuth] = useState<AuthState>('loading');
  const hash = useHashRoute();

  async function refreshAuth() {
    try {
      const session = await api.get<Session>('/auth/session');
      setAuth(session.setupRequired ? 'setup' : session.authenticated ? 'ready' : 'login');
    } catch {
      setAuth('login');
    }
  }

  useEffect(() => {
    void refreshAuth();
  }, []);

  if (auth === 'loading') {
    return null;
  }
  if (auth === 'setup') {
    return <SetupPage onDone={() => void refreshAuth()} />;
  }
  if (auth === 'login') {
    return <LoginPage onDone={() => void refreshAuth()} />;
  }

  const vaultMatch = /^#\/vault\/(.+)$/.exec(hash);
  if (vaultMatch) {
    return <VaultDetailPage vaultId={vaultMatch[1]!} />;
  }
  return (
    <Dashboard
      onLogout={() =>
        void api.post('/auth/logout').then(() => {
          location.hash = '#/';
          void refreshAuth();
        })
      }
    />
  );
}

import React from 'react';
import { PrototypeIcon } from './PrototypeIcon.js';
import { AuthScreen } from './auth/AuthScreen.js';
import { useAuth } from './auth/useAuth.js';
import { Dashboard } from './dashboard/Dashboard.js';
import { DocumentEditor } from './editor/DocumentEditor.js';
import { useRoute } from './routing.js';

export function App(): React.JSX.Element {
  const { user, sessionChecked, authPending, onAuthExpired, signOut, form } = useAuth();
  const route = useRoute();

  if (!sessionChecked) {
    return (
      <main className="auth-shell" aria-live="polite">
        <section className="auth-panel">
          <div className="brand-mark" aria-hidden="true">P</div>
          <p className="eyebrow">PRICED</p>
          <p className="loading-message">Checking your private workspace…</p>
        </section>
      </main>
    );
  }

  if (!user) return <AuthScreen form={form} />;

  return (
    <div className="app-frame">
      <header className="app-topbar">
        <a className="brand-lockup" href="#/documents" aria-label="Priced home">
          <span className="brand-mark" aria-hidden="true">P</span>
          <span className="brand-name">Priced</span>
        </a>
        <nav className="primary-nav" aria-label="Main navigation">
          <a className={`nav-link${route.kind === 'dashboard' ? ' active' : ''}`} href="#/documents" aria-current={route.kind === 'dashboard' ? 'page' : undefined} aria-label="Documents">
            <PrototypeIcon name="file" /><span className="nav-label">Documents</span>
          </a>
        </nav>
        <div className="account-actions">
          <span className="account-email">{user.email}</span>
          <button className="text-button" type="button" disabled={authPending} onClick={() => void signOut()}>
            {authPending ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      </header>

      {route.kind === 'dashboard' ? (
        <Dashboard key={user.id} user={user} onAuthExpired={onAuthExpired} />
      ) : (
        <DocumentEditor
          key={`${user.id}:${route.key}`}
          owner={user}
          documentId={route.kind === 'document' ? route.id : undefined}
          onAuthExpired={onAuthExpired}
        />
      )}
    </div>
  );
}

import React from 'react';
import type { useAuth } from './useAuth.js';

export function AuthScreen({ form }: { form: ReturnType<typeof useAuth>['form'] }): React.JSX.Element {
  const {
    mode, authValues, authMessage, pendingOperation, fieldErrors,
    showEmailError, showPasswordError, authenticate, changeAuthField, touchAuthField, changeMode,
  } = form;

  return (
    <main className="auth-shell">
      <section className="auth-panel">
        <div className="brand-mark" aria-hidden="true">P</div>
        <p className="eyebrow">PRIVATE WORKSPACE</p>
        <h1>{mode === 'sign-in' ? 'Sign in to your workspace' : 'Create your private workspace'}</h1>
        <p className="lead">{mode === 'sign-in'
          ? 'Your pricing documents stay private to your account.'
          : 'Create an account to keep your pricing documents in one private place.'}</p>

        <form className="auth-form" noValidate onSubmit={authenticate}>
          <div className="field">
            <label htmlFor="email">Email address</label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              value={authValues.email}
              aria-invalid={Boolean(showEmailError && fieldErrors.email)}
              aria-describedby={showEmailError && fieldErrors.email ? 'email-error' : undefined}
              onChange={event => changeAuthField('email', event.currentTarget.value)}
              onBlur={() => touchAuthField('email')}
            />
            {showEmailError && fieldErrors.email && <p className="field-error" id="email-error" role="alert">{fieldErrors.email}</p>}
          </div>

          <div className="field">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete={mode === 'sign-in' ? 'current-password' : 'new-password'}
              required
              value={authValues.password}
              aria-invalid={Boolean(showPasswordError && fieldErrors.password)}
              aria-describedby={showPasswordError && fieldErrors.password ? 'password-error' : undefined}
              onChange={event => changeAuthField('password', event.currentTarget.value)}
              onBlur={() => touchAuthField('password')}
            />
            {showPasswordError && fieldErrors.password && <p className="field-error" id="password-error" role="alert">{fieldErrors.password}</p>}
            {mode === 'sign-up' && <p className="field-hint">6 to 10 Unicode code points. Symbols welcome.</p>}
          </div>

          {authMessage && <p className="request-error" role="alert">{authMessage}</p>}
          <button className="primary-button" type="submit" disabled={pendingOperation !== null}>
            {pendingOperation === 'sign-out' ? 'Signing out…'
              : pendingOperation === 'sign-in' ? 'Signing in…'
              : pendingOperation === 'sign-up' ? 'Creating account…'
              : mode === 'sign-in' ? 'Sign in' : 'Create account'}
          </button>
        </form>

        <p className="privacy-note">
          {mode === 'sign-in' ? 'New here?' : 'Already have an account?'}{' '}
          <button className="auth-switch" type="button" onClick={() => changeMode(mode === 'sign-in' ? 'sign-up' : 'sign-in')}>
            {mode === 'sign-in' ? 'Create account' : 'Sign in'}
          </button>
        </p>
      </section>
    </main>
  );
}

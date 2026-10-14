import React from 'react';
import { createRoot } from 'react-dom/client';
import { validateRegistrationFields } from '../shared/auth-validation.js';
import './styles.css';

type User = { id: string; email: string };
type RegistrationValues = { email: string; password: string };
type AuthMode = 'sign-in' | 'sign-up';
type FieldErrors = Partial<Record<keyof RegistrationValues, string>>;

function validateRegistration(values: RegistrationValues): FieldErrors {
  const { fields } = validateRegistrationFields(values.email, values.password);
  const errors: FieldErrors = {};
  if (fields.email) errors.email = fields.email;
  if (fields.password) errors.password = fields.password;
  return errors;
}

function App(): React.JSX.Element {
  const [user, setUser] = React.useState<User | null>(null);
  const [sessionChecked, setSessionChecked] = React.useState(false);
  const [mode, setMode] = React.useState<AuthMode>('sign-in');
  const [values, setValues] = React.useState<RegistrationValues>({ email: '', password: '' });
  const [touched, setTouched] = React.useState<Partial<Record<keyof RegistrationValues, boolean>>>({});
  const [submitted, setSubmitted] = React.useState(false);
  const [serverErrors, setServerErrors] = React.useState<FieldErrors>({});
  const [requestError, setRequestError] = React.useState('');
  const [pending, setPending] = React.useState(false);

  React.useEffect(() => {
    let active = true;
    void fetch('/auth/session')
      .then(async response => {
        if (!response.ok) return null;
        const result = await response.json() as { user: User };
        return result.user;
      })
      .catch(() => null)
      .then(foundUser => {
        if (!active) return;
        setUser(foundUser);
        setSessionChecked(true);
      });
    return () => { active = false; };
  }, []);

  const localErrors = validateRegistration(values);
  const fieldErrors: FieldErrors = {
    email: serverErrors.email ?? localErrors.email,
    password: serverErrors.password ?? localErrors.password,
  };
  const showEmailError = submitted || touched.email;
  const showPasswordError = submitted || touched.password;

  function changeField(field: keyof RegistrationValues, value: string): void {
    setValues(current => ({ ...current, [field]: value }));
    setTouched(current => ({ ...current, [field]: true }));
    setServerErrors({});
    setRequestError('');
  }

  async function authenticate(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSubmitted(true);
    const errors = validateRegistration(values);
    if (Object.keys(errors).length > 0) return;

    setPending(true);
    setRequestError('');
    setServerErrors({});
    try {
      const response = await fetch(mode === 'sign-in' ? '/auth/sign-in' : '/auth/sign-up', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: values.email, password: values.password }),
      });
      const result = await response.json() as {
        user?: User;
        error?: { message?: string; fields?: Record<string, string> };
      };
      if (!response.ok) {
        setServerErrors({
          email: result.error?.fields?.email,
          password: result.error?.fields?.password,
        });
        setRequestError(result.error?.message ?? (mode === 'sign-in'
          ? 'Could not sign in. Try again.'
          : 'Could not create your account. Try again.'));
        return;
      }
      if (result.user) {
        setUser(result.user);
        setValues(current => ({ ...current, password: '' }));
      }
    } catch {
      setRequestError('Connection failed. Check your network and try again.');
    } finally {
      setPending(false);
    }
  }

  async function signOut(): Promise<void> {
    setPending(true);
    setRequestError('');
    try {
      const response = await fetch('/auth/logout', { method: 'POST' });
      if (!response.ok) {
        const result = await response.json() as { error?: { message?: string } };
        setRequestError(result.error?.message ?? 'Could not sign out. Try again.');
        return;
      }
      setUser(null);
      setMode('sign-in');
      setValues({ email: '', password: '' });
      setTouched({});
      setSubmitted(false);
    } catch {
      setRequestError('Connection failed. Check your network and try again.');
    } finally {
      setPending(false);
    }
  }

  function changeMode(nextMode: AuthMode): void {
    setMode(nextMode);
    setTouched({});
    setSubmitted(false);
    setServerErrors({});
    setRequestError('');
  }

  return (
    <main className="page-shell">
      {!sessionChecked ? (
        <section className="auth-panel" aria-live="polite">
          <div className="brand-mark" aria-hidden="true">MR</div>
          <p className="eyebrow">MULTI-RATE PRICING</p>
          <p className="loading-message">Checking your private workspace…</p>
        </section>
      ) : user ? (
        <section className="auth-panel welcome-panel">
          <div className="brand-mark" aria-hidden="true">MR</div>
          <p className="eyebrow">PRIVATE WORKSPACE</p>
          <h1>Welcome, {user.email}</h1>
          <p className="lead">Your private pricing workspace is ready.</p>
          <p className="privacy-note">Your documents belong to your account and stay private.</p>
          {requestError && <p className="request-error" role="alert">{requestError}</p>}
          <button className="primary-button" type="button" disabled={pending} onClick={() => void signOut()}>
            {pending ? 'Signing out…' : 'Sign out'}
          </button>
        </section>
      ) : (
        <section className="auth-panel">
          <div className="brand-mark" aria-hidden="true">MR</div>
          <p className="eyebrow">PRIVATE WORKSPACE</p>
          <h1>{mode === 'sign-in' ? 'Sign in to your workspace' : 'Create your private workspace'}</h1>
          <p className="lead">{mode === 'sign-in'
            ? 'Your pricing documents stay private to your account.'
            : 'Create an account to keep your pricing documents in one private place.'}</p>

          <form className="signup-form" noValidate onSubmit={authenticate}>
            <div className="field">
              <label htmlFor="email">Email address</label>
              <input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                required
                value={values.email}
                aria-invalid={Boolean(showEmailError && fieldErrors.email)}
                aria-describedby={showEmailError && fieldErrors.email ? 'email-error' : undefined}
                onChange={event => changeField('email', event.currentTarget.value)}
                onBlur={() => setTouched(current => ({ ...current, email: true }))}
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
                value={values.password}
                aria-invalid={Boolean(showPasswordError && fieldErrors.password)}
                aria-describedby={showPasswordError && fieldErrors.password ? 'password-error' : undefined}
                onChange={event => changeField('password', event.currentTarget.value)}
                onBlur={() => setTouched(current => ({ ...current, password: true }))}
              />
              {showPasswordError && fieldErrors.password && <p className="field-error" id="password-error" role="alert">{fieldErrors.password}</p>}
              {mode === 'sign-up' && <p className="field-hint">6 to 10 Unicode code points. Symbols welcome.</p>}
            </div>

            {requestError && <p className="request-error" role="alert">{requestError}</p>}
            <button className="primary-button" type="submit" disabled={pending}>
              {pending ? (mode === 'sign-in' ? 'Signing in…' : 'Creating account…') : (mode === 'sign-in' ? 'Sign in' : 'Create account')}
            </button>
          </form>

          <p className="privacy-note">
            {mode === 'sign-in' ? 'New here?' : 'Already have an account?'}{' '}
            <button className="auth-switch" type="button" onClick={() => changeMode(mode === 'sign-in' ? 'sign-up' : 'sign-in')}>
              {mode === 'sign-in' ? 'Create account' : 'Sign in'}
            </button>
          </p>
        </section>
      )}
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<App />);

import React from 'react';
import { validateRegistrationFields } from '../../shared/auth-validation.js';
import type { User, FieldErrors } from '../api/contracts.js';
import { responseError } from '../api/client.js';
import { clearUserEditorValues } from '../editor/storage.js';
import { navigate } from '../routing.js';

type RegistrationValues = { email: string; password: string };
type AuthMode = 'sign-in' | 'sign-up';

export function useAuth() {
  const [user, setUser] = React.useState<User | null>(null);
  const [sessionChecked, setSessionChecked] = React.useState(false);
  const [mode, setMode] = React.useState<AuthMode>('sign-in');
  const [authValues, setAuthValues] = React.useState<RegistrationValues>({ email: '', password: '' });
  const [touched, setTouched] = React.useState<Partial<Record<keyof RegistrationValues, boolean>>>({});
  const [authSubmitted, setAuthSubmitted] = React.useState(false);
  const [serverAuthErrors, setServerAuthErrors] = React.useState<Partial<Record<keyof RegistrationValues, string>>>({});
  const [authMessage, setAuthMessage] = React.useState('');
  const [authPending, setAuthPending] = React.useState(false);
  const [sessionError, setSessionError] = React.useState('');
  const [signOutPending, setSignOutPending] = React.useState(false);

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

  const onAuthExpired = React.useCallback(() => {
    setUser(null);
    setSessionError('');
    setMode('sign-in');
    setAuthMessage('Your session expired. Sign in to resume editing.');
  }, []);

  async function authenticate(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setAuthSubmitted(true);
    const { fields: localErrors } = validateRegistrationFields(authValues.email, authValues.password);
    if (localErrors.email || localErrors.password) return;

    setAuthPending(true);
    setAuthMessage('');
    setServerAuthErrors({});
    try {
      const response = await fetch(mode === 'sign-in' ? '/auth/sign-in' : '/auth/sign-up', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: authValues.email, password: authValues.password }),
      });
      const result = await response.json() as { user?: User; error?: { message?: string; fields?: FieldErrors } };
      if (!response.ok) {
        setServerAuthErrors({
          email: result.error?.fields?.email,
          password: result.error?.fields?.password,
        });
        setAuthMessage(result.error?.message ?? (mode === 'sign-in'
          ? 'Could not sign in. Try again.'
          : 'Could not create your account. Try again.'));
        return;
      }
      if (result.user) {
        setUser(result.user);
        setSessionError('');
        setAuthValues(current => ({ ...current, password: '' }));
        setAuthMessage('');
      }
    } catch {
      setAuthMessage('Connection failed. Check your network and try again.');
    } finally {
      setAuthPending(false);
    }
  }

  async function signOut(): Promise<void> {
    setSignOutPending(true);
    setSessionError('');
    try {
      const response = await fetch('/auth/logout', { method: 'POST' });
      if (!response.ok) {
        const error = await responseError(response);
        if (response.status === 401) onAuthExpired();
        else setSessionError(error.message ?? 'Could not sign out. Try again.');
        return;
      }
      if (user) clearUserEditorValues(user.id);
      setUser(null);
      setMode('sign-in');
      setAuthMessage('');
      setAuthValues({ email: '', password: '' });
      setTouched({});
      setAuthSubmitted(false);
      navigate('/documents');
    } catch {
      setSessionError('Connection failed. Check your network and try again.');
    } finally {
      setSignOutPending(false);
    }
  }

  function changeAuthField(field: keyof RegistrationValues, value: string): void {
    setAuthValues(current => ({ ...current, [field]: value }));
    setTouched(current => ({ ...current, [field]: true }));
    setServerAuthErrors({});
    setAuthMessage('');
  }

  function changeMode(nextMode: AuthMode): void {
    setMode(nextMode);
    setTouched({});
    setAuthSubmitted(false);
    setServerAuthErrors({});
    setAuthMessage('');
  }

  const { fields: localAuthErrors } = validateRegistrationFields(authValues.email, authValues.password);
  const fieldErrors = {
    email: serverAuthErrors.email ?? localAuthErrors.email,
    password: serverAuthErrors.password ?? localAuthErrors.password,
  };
  const showEmailError = authSubmitted || touched.email;
  const showPasswordError = authSubmitted || touched.password;

  function touchAuthField(field: keyof RegistrationValues): void {
    setTouched(current => ({ ...current, [field]: true }));
  }

  return {
    user,
    sessionChecked,
    sessionError,
    signOutPending,
    onAuthExpired,
    signOut,
    form: {
      mode,
      authValues,
      authMessage,
      authPending,
      fieldErrors,
      showEmailError,
      showPasswordError,
      authenticate,
      changeAuthField,
      touchAuthField,
      changeMode,
    },
  };
}

import React from 'react';
import { createRoot } from 'react-dom/client';
import { isCalendarDate } from '../shared/document-validation.js';
import { amountsWithinSafeRange, calculateDocumentAmounts, calculateLineAmounts, MAX_SAFE_AMOUNT } from '../shared/pricing.js';
import { validateRegistrationFields } from '../shared/auth-validation.js';
import './styles.css';

type User = { id: string; email: string };
type RegistrationValues = { email: string; password: string };
type AuthMode = 'sign-in' | 'sign-up';
type DocumentValues = { title: string; customerName: string; issueDate: string };
type LineValues = {
  key: string;
  id?: string;
  description: string;
  quantity: string;
  unitPrice: string;
  discount: string;
  taxRate: string;
  amounts?: Amounts;
};
type EditableLineField = 'description' | 'quantity' | 'unitPrice' | 'discount' | 'taxRate';
type Amounts = {
  subtotalCents: number;
  discountCents: number;
  taxableCents: number;
  taxCents: number;
  totalCents: number;
};
type DocumentSummary = {
  id: string;
  title: string;
  customerName: string;
  issueDate: string;
  status: 'draft' | 'finalized';
  amounts: Amounts;
};
type DocumentData = DocumentSummary & {
  createdAt: string;
  updatedAt: string;
  finalizedAt: string | null;
  lineItems: Array<{
    id: string;
    position: number;
    description: string;
    quantity: number;
    unitPriceCents: number;
    discountCents: number;
    taxRateBasisPoints: number;
    amounts: Amounts;
  }>;
};
type FieldErrors = Record<string, string>;
type Route = { kind: 'dashboard' } | { kind: 'new' } | { kind: 'document'; id: string };

const EDITOR_STORAGE_PREFIX = 'pricing-calculator:editor:';

function lineStorageKey(ownerId: string, documentId?: string): string {
  return `${EDITOR_STORAGE_PREFIX}${ownerId}:${documentId ?? 'new'}:lines`;
}

function newLineValues(): LineValues {
  return {
    key: globalThis.crypto.randomUUID(),
    description: '',
    quantity: '1',
    unitPrice: '0.00',
    discount: '0.00',
    taxRate: '0.00',
  };
}

function lineValuesFromDocument(document: DocumentData): LineValues[] {
  return document.lineItems.map(line => ({
    key: line.id,
    id: line.id,
    description: line.description,
    quantity: String(line.quantity),
    unitPrice: centsToInput(line.unitPriceCents),
    discount: centsToInput(line.discountCents),
    taxRate: `${Math.floor(line.taxRateBasisPoints / 100)}.${String(line.taxRateBasisPoints % 100).padStart(2, '0')}`,
    amounts: line.amounts,
  }));
}

function readEditorLines(ownerId: string, documentId?: string): LineValues[] | null {
  try {
    const stored = window.sessionStorage.getItem(lineStorageKey(ownerId, documentId));
    if (!stored) return null;
    const lines = JSON.parse(stored) as unknown;
    if (!Array.isArray(lines)) return null;
    return lines.filter((line): line is LineValues => isLineValues(line));
  } catch {
    return null;
  }
}

function isLineValues(value: unknown): value is LineValues {
  if (typeof value !== 'object' || value === null) return false;
  const line = value as Partial<LineValues>;
  return typeof line.key === 'string'
    && (line.id === undefined || typeof line.id === 'string')
    && typeof line.description === 'string'
    && typeof line.quantity === 'string'
    && typeof line.unitPrice === 'string'
    && typeof line.discount === 'string'
    && typeof line.taxRate === 'string'
    && (line.amounts === undefined || typeof line.amounts === 'object');
}

function storeEditorLines(ownerId: string, documentId: string | undefined, lines: LineValues[]): void {
  try {
    window.sessionStorage.setItem(lineStorageKey(ownerId, documentId), JSON.stringify(lines));
  } catch {
    // Live form state remains available when browser storage is unavailable.
  }
}

function centsToInput(cents: number): string {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

function parseMoneyInput(value: string): bigint | null {
  const normalized = value.trim().replace(',', '.');
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return null;
  const [whole, fraction = ''] = normalized.split('.');
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  return cents <= MAX_SAFE_AMOUNT ? cents : null;
}

function parseQuantityInput(value: string): bigint | null {
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) return null;
  const quantity = BigInt(normalized);
  return quantity > 0n && quantity <= MAX_SAFE_AMOUNT ? quantity : null;
}

function parseTaxInput(value: string): number | null {
  const normalized = value.trim().replace(',', '.');
  if (!/^(?:\d+)(?:\.\d{1,2})?$/.test(normalized)) return null;
  const [whole, fraction = ''] = normalized.split('.');
  const basisPoints = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  return basisPoints <= 10_000n ? Number(basisPoints) : null;
}

type LineInputErrors = Partial<Record<'quantity' | 'unitPrice' | 'discount' | 'taxRate', string>>;
type LinePreview = { errors: LineInputErrors; amounts?: Amounts; input?: {
  quantity: bigint;
  unitPriceCents: bigint;
  discountCents: bigint;
  taxRateBasisPoints: number;
} };

function previewLine(line: LineValues): LinePreview {
  const errors: LineInputErrors = {};
  const quantity = parseQuantityInput(line.quantity);
  const unitPriceCents = parseMoneyInput(line.unitPrice);
  const discountCents = parseMoneyInput(line.discount);
  const taxRateBasisPoints = parseTaxInput(line.taxRate);
  if (quantity === null) errors.quantity = 'Enter a positive whole quantity.';
  if (unitPriceCents === null) errors.unitPrice = 'Enter a EUR amount with up to two decimals.';
  if (discountCents === null) errors.discount = 'Enter a EUR amount with up to two decimals.';
  if (taxRateBasisPoints === null) errors.taxRate = 'Enter a tax rate from 0 to 100.00%.';
  if (Object.keys(errors).length > 0 || quantity === null || unitPriceCents === null || discountCents === null || taxRateBasisPoints === null) {
    return { errors };
  }

  const input = { quantity, unitPriceCents, discountCents, taxRateBasisPoints };
  const amounts = calculateLineAmounts(input);
  if (discountCents > amounts.subtotalCents) {
    errors.discount = 'Discount cannot exceed the line subtotal.';
  }
  if (!amountsWithinSafeRange(amounts)) {
    errors.unitPrice = 'Line amounts exceed the supported safe integer range.';
  }
  if (Object.keys(errors).length > 0) return { errors };
  if (line.id && line.amounts) return { errors, input, amounts: line.amounts };
  return {
    errors,
    input,
    amounts: {
      subtotalCents: Number(amounts.subtotalCents),
      discountCents: Number(amounts.discountCents),
      taxableCents: Number(amounts.taxableCents),
      taxCents: Number(amounts.taxCents),
      totalCents: Number(amounts.totalCents),
    },
  };
}

function authFieldErrors(values: RegistrationValues): Partial<Record<keyof RegistrationValues, string>> {
  const { fields } = validateRegistrationFields(values.email, values.password);
  return { email: fields.email, password: fields.password };
}

function documentFieldErrors(values: DocumentValues): FieldErrors {
  const errors: FieldErrors = {};
  if (!values.title.trim()) errors.title = 'Enter a document name.';
  if (!isCalendarDate(values.issueDate)) errors.issueDate = 'Enter a valid issue date.';
  return errors;
}

function routeFromHash(): Route {
  const match = /^#\/documents(?:\/([^/?#]+))?$/.exec(window.location.hash);
  if (!match?.[1]) return { kind: 'dashboard' };
  if (match[1] === 'new') return { kind: 'new' };
  return { kind: 'document', id: decodeURIComponent(match[1]) };
}

function useRoute(): Route {
  const [route, setRoute] = React.useState<Route>(routeFromHash);
  React.useEffect(() => {
    if (!window.location.hash) window.history.replaceState(null, '', '#/documents');
    const sync = (): void => setRoute(routeFromHash());
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);
  return route;
}

function navigate(path: string): void {
  window.location.hash = path;
}

function localToday(): string {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function editorStorageKey(ownerId: string, documentId?: string): string {
  return `${EDITOR_STORAGE_PREFIX}${ownerId}:${documentId ?? 'new'}`;
}

function readEditorValues(ownerId: string, documentId?: string): DocumentValues | null {
  try {
    const stored = window.sessionStorage.getItem(editorStorageKey(ownerId, documentId));
    if (!stored) return null;
    const value = JSON.parse(stored) as Partial<DocumentValues>;
    if (typeof value.title !== 'string' || typeof value.customerName !== 'string' || typeof value.issueDate !== 'string') return null;
    return { title: value.title, customerName: value.customerName, issueDate: value.issueDate };
  } catch {
    return null;
  }
}

function storeEditorValues(ownerId: string, documentId: string | undefined, values: DocumentValues): void {
  try {
    window.sessionStorage.setItem(editorStorageKey(ownerId, documentId), JSON.stringify(values));
  } catch {
    // Browser storage can be unavailable; the live form still keeps its input.
  }
}

function clearEditorValues(ownerId: string, documentId?: string): void {
  try {
    window.sessionStorage.removeItem(editorStorageKey(ownerId, documentId));
    window.sessionStorage.removeItem(lineStorageKey(ownerId, documentId));
  } catch {
    // The server copy remains authoritative after a successful save.
  }
}

function clearUserEditorValues(ownerId: string): void {
  try {
    const prefix = `${EDITOR_STORAGE_PREFIX}${ownerId}:`;
    for (let index = window.sessionStorage.length - 1; index >= 0; index -= 1) {
      const key = window.sessionStorage.key(index);
      if (key?.startsWith(prefix)) window.sessionStorage.removeItem(key);
    }
  } catch {
    // Nothing to clear when browser storage is unavailable.
  }
}

function formatDate(value: string): string {
  if (!isCalendarDate(value)) return 'Date not set';
  const [year, month, day] = value.split('-').map(Number);
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
    .format(new Date(year, month - 1, day));
}

const EURO_WHOLE_FORMATTER = new Intl.NumberFormat('en-IE', {
  style: 'currency', currency: 'EUR', minimumFractionDigits: 0, maximumFractionDigits: 0,
});
const EURO_DECIMAL_SEPARATOR = new Intl.NumberFormat('en-IE', { minimumFractionDigits: 1 })
  .formatToParts(1.1)
  .find(part => part.type === 'decimal')?.value ?? '.';

function formatEuro(cents: number): string {
  const signed = BigInt(cents);
  const negative = signed < 0n;
  const absolute = negative ? -signed : signed;
  const wholeEuros = Number(absolute / 100n);
  const fraction = String(absolute % 100n).padStart(2, '0');
  return `${negative ? '−' : ''}${EURO_WHOLE_FORMATTER.format(wholeEuros)}${EURO_DECIMAL_SEPARATOR}${fraction}`;
}

async function responseError(response: Response): Promise<{ message?: string; fields?: FieldErrors }> {
  try {
    const result = await response.json() as { error?: { message?: string; fields?: FieldErrors } };
    return result.error ?? {};
  } catch {
    return {};
  }
}

function App(): React.JSX.Element {
  const [user, setUser] = React.useState<User | null>(null);
  const [sessionChecked, setSessionChecked] = React.useState(false);
  const [mode, setMode] = React.useState<AuthMode>('sign-in');
  const [authValues, setAuthValues] = React.useState<RegistrationValues>({ email: '', password: '' });
  const [touched, setTouched] = React.useState<Partial<Record<keyof RegistrationValues, boolean>>>({});
  const [authSubmitted, setAuthSubmitted] = React.useState(false);
  const [serverAuthErrors, setServerAuthErrors] = React.useState<Partial<Record<keyof RegistrationValues, string>>>({});
  const [authMessage, setAuthMessage] = React.useState('');
  const [authPending, setAuthPending] = React.useState(false);
  const route = useRoute();

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
    setMode('sign-in');
    setAuthMessage('Your session expired. Sign in to resume editing.');
  }, []);

  async function authenticate(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setAuthSubmitted(true);
    const localErrors = authFieldErrors(authValues);
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
    if (user) clearUserEditorValues(user.id);
    setAuthPending(true);
    setAuthMessage('');
    try {
      const response = await fetch('/auth/logout', { method: 'POST' });
      if (!response.ok) {
        const error = await responseError(response);
        if (response.status === 401) onAuthExpired();
        else setAuthMessage(error.message ?? 'Could not sign out. Try again.');
        return;
      }
      setUser(null);
      setMode('sign-in');
      setAuthValues({ email: '', password: '' });
      setTouched({});
      setAuthSubmitted(false);
      navigate('/documents');
    } catch {
      setAuthMessage('Connection failed. Check your network and try again.');
    } finally {
      setAuthPending(false);
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

  const localAuthErrors = authFieldErrors(authValues);
  const fieldErrors = {
    email: serverAuthErrors.email ?? localAuthErrors.email,
    password: serverAuthErrors.password ?? localAuthErrors.password,
  };
  const showEmailError = authSubmitted || touched.email;
  const showPasswordError = authSubmitted || touched.password;

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

  if (!user) {
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
                value={authValues.password}
                aria-invalid={Boolean(showPasswordError && fieldErrors.password)}
                aria-describedby={showPasswordError && fieldErrors.password ? 'password-error' : undefined}
                onChange={event => changeAuthField('password', event.currentTarget.value)}
                onBlur={() => setTouched(current => ({ ...current, password: true }))}
              />
              {showPasswordError && fieldErrors.password && <p className="field-error" id="password-error" role="alert">{fieldErrors.password}</p>}
              {mode === 'sign-up' && <p className="field-hint">6 to 10 Unicode code points. Symbols welcome.</p>}
            </div>

            {authMessage && <p className="request-error" role="alert">{authMessage}</p>}
            <button className="primary-button" type="submit" disabled={authPending}>
              {authPending ? (mode === 'sign-in' ? 'Signing in…' : 'Creating account…') : (mode === 'sign-in' ? 'Sign in' : 'Create account')}
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

  return (
    <div className="app-frame">
      <header className="app-topbar">
        <a className="brand-lockup" href="#/documents" aria-label="Priced home">
          <span className="brand-mark" aria-hidden="true">P</span>
          <span className="brand-name">Priced</span>
        </a>
        <nav className="primary-nav" aria-label="Main navigation">
          <a className="nav-link" href="#/documents">Documents</a>
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
          key={`${user.id}:${route.kind === 'document' ? route.id : 'new'}`}
          owner={user}
          documentId={route.kind === 'document' ? route.id : undefined}
          onAuthExpired={onAuthExpired}
        />
      )}
    </div>
  );
}

function Dashboard({ user, onAuthExpired }: { user: User; onAuthExpired: () => void }): React.JSX.Element {
  const [items, setItems] = React.useState<DocumentSummary[]>([]);
  const [totalItems, setTotalItems] = React.useState(0);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState('');

  React.useEffect(() => {
    let active = true;
    void fetch('/documents')
      .then(async response => {
        if (response.status === 401) {
          onAuthExpired();
          return null;
        }
        if (!response.ok) throw new Error((await responseError(response)).message ?? 'Could not load documents.');
        return response.json() as Promise<{ items: DocumentSummary[]; totalItems: number }>;
      })
      .then(result => {
        if (!active || !result) return;
        setItems(result.items);
        setTotalItems(result.totalItems);
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : 'Could not load documents.');
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [onAuthExpired, user.id]);

  return (
    <main className="dashboard-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">PRIVATE WORKSPACE</p>
          <h1>Documents</h1>
        </div>
        <button className="primary-button" type="button" onClick={() => navigate('/documents/new')}>
          New document
        </button>
      </div>

      <section className="document-list-section" aria-labelledby="document-list-title">
        <div className="section-heading list-heading">
          <h2 id="document-list-title">All documents</h2>
          <span>{loading ? 'Loading…' : `${totalItems} ${totalItems === 1 ? 'document' : 'documents'}`}</span>
        </div>
        {error && <p className="request-error" role="alert">{error}</p>}
        {loading ? (
          <p className="empty-state" aria-live="polite">Loading your documents…</p>
        ) : items.length === 0 ? (
          <div className="empty-state">
            <p>No documents yet.</p>
            <p>Start with a name and issue date. Add customer details when ready.</p>
          </div>
        ) : (
          <div className="table-scroll">
            <table className="document-table">
              <thead>
                <tr>
                  <th scope="col">Title</th>
                  <th scope="col">Customer</th>
                  <th scope="col">Issue date</th>
                  <th scope="col">Status</th>
                  <th className="number-cell" scope="col">Total</th>
                </tr>
              </thead>
              <tbody>
                {items.map(item => (
                  <tr key={item.id}>
                    <th scope="row">
                      <a className="table-link" href={`#/documents/${encodeURIComponent(item.id)}`}>
                        {item.title}
                      </a>
                    </th>
                    <td>{item.customerName || '—'}</td>
                    <td>{formatDate(item.issueDate)}</td>
                    <td><span className={`status-badge ${item.status}`}>{item.status === 'draft' ? 'Draft' : 'Finalized'}</span></td>
                    <td className="number-cell">{formatEuro(item.amounts.totalCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}

function DocumentEditor({
  owner,
  documentId,
  onAuthExpired,
}: {
  owner: User;
  documentId?: string;
  onAuthExpired: () => void;
}): React.JSX.Element {
  const [document, setDocument] = React.useState<DocumentData | null>(null);
  const [values, setValues] = React.useState<DocumentValues | null>(() => documentId
    ? null
    : readEditorValues(owner.id) ?? { title: '', customerName: '', issueDate: localToday() });
  const [lines, setLines] = React.useState<LineValues[]>(() => documentId ? [] : readEditorLines(owner.id) ?? []);
  const [loading, setLoading] = React.useState(Boolean(documentId));
  const [loadError, setLoadError] = React.useState('');
  const [serverErrors, setServerErrors] = React.useState<FieldErrors>({});
  const [message, setMessage] = React.useState('');
  const [submitted, setSubmitted] = React.useState(false);
  const [pending, setPending] = React.useState(false);

  React.useEffect(() => {
    if (!documentId) return;
    let active = true;
    void fetch(`/documents/${encodeURIComponent(documentId)}`)
      .then(async response => {
        if (response.status === 401) {
          onAuthExpired();
          return null;
        }
        if (response.status === 404) throw new Error('Document not found.');
        if (!response.ok) throw new Error((await responseError(response)).message ?? 'Could not load this document.');
        return response.json() as Promise<DocumentData>;
      })
      .then(result => {
        if (!active || !result) return;
        setDocument(result);
        setValues(readEditorValues(owner.id, documentId) ?? {
          title: result.title,
          customerName: result.customerName,
          issueDate: result.issueDate,
        });
        const savedLines = lineValuesFromDocument(result);
        const recoveredLines = readEditorLines(owner.id, documentId);
        const savedIds = new Set(savedLines.map(line => line.id));
        const unsavedLines = recoveredLines?.filter(line => !line.id || !savedIds.has(line.id)) ?? [];
        setLines([...savedLines, ...unsavedLines]);
      })
      .catch((reason: unknown) => {
        if (active) setLoadError(reason instanceof Error ? reason.message : 'Could not load this document.');
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [documentId, onAuthExpired, owner.id]);

  if (loading || !values) {
    return (
      <main className="ledger-page" aria-live="polite">
        {loadError ? <p className="request-error" role="alert">{loadError}</p> : <p>Loading document…</p>}
        <button className="back-link" type="button" onClick={() => navigate('/documents')}>← All documents</button>
      </main>
    );
  }

  const localErrors = documentFieldErrors(values);
  const linePreviews = lines.map(previewLine);
  const hasLineErrors = linePreviews.some(preview => Object.keys(preview.errors).length > 0);
  const previewAmounts = (() => {
    if (hasLineErrors) return undefined;
    const exact = calculateDocumentAmounts(linePreviews.flatMap(preview => preview.input ? [preview.input] : []));
    if (!amountsWithinSafeRange(exact)) return undefined;
    return {
      subtotalCents: Number(exact.subtotalCents),
      discountCents: Number(exact.discountCents),
      taxableCents: Number(exact.taxableCents),
      taxCents: Number(exact.taxCents),
      totalCents: Number(exact.totalCents),
    };
  })();
  const titleError = serverErrors.title ?? (submitted ? localErrors.title : undefined);
  const dateError = serverErrors.issueDate ?? (submitted ? localErrors.issueDate : undefined);
  const canEdit = !document || document.status === 'draft';
  const statusLabel = !document ? 'Unsaved document' : document.status === 'draft' ? 'Editable draft' : 'Fixed snapshot';

  function changeField(field: keyof DocumentValues, value: string): void {
    const next = { ...values!, [field]: value };
    setValues(next);
    storeEditorValues(owner.id, documentId, next);
    setServerErrors(current => {
      const updated = { ...current };
      delete updated[field];
      return updated;
    });
    setMessage('');
  }

  function changeLine(key: string, field: EditableLineField, value: string): void {
    const next = lines.map(line => line.key === key && !line.id ? { ...line, [field]: value } : line);
    setLines(next);
    storeEditorLines(owner.id, documentId, next);
    setMessage('');
  }

  function addLine(): void {
    const next = [...lines, newLineValues()];
    setLines(next);
    storeEditorLines(owner.id, documentId, next);
    setSubmitted(false);
    setMessage('');
  }

  async function saveDraft(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSubmitted(true);
    setMessage('');
    const errors = documentFieldErrors(values!);
    setServerErrors({});
    if (Object.keys(errors).length > 0) return;
    if (hasLineErrors || !previewAmounts) {
      setMessage(hasLineErrors ? 'Check line item fields before saving.' : 'Document amounts exceed the supported safe integer range.');
      return;
    }

    setPending(true);
    let createdDocumentId: string | undefined;
    let linesBeingSaved = [...lines];
    try {
      const response = await fetch(documentId ? `/documents/${encodeURIComponent(documentId)}` : '/documents', {
        method: documentId ? 'PATCH' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(values),
      });
      if (response.status === 401) {
        onAuthExpired();
        return;
      }
      const result = await response.json() as DocumentData | { error?: { message?: string; fields?: FieldErrors } };
      if (!response.ok) {
        const error = (result as { error?: { message?: string; fields?: FieldErrors } }).error;
        setServerErrors(error?.fields ?? {});
        setMessage(error?.message ?? 'Could not save this draft.');
        return;
      }
      const saved = result as DocumentData;
      createdDocumentId = saved.id;
      if (!documentId) {
        clearEditorValues(owner.id);
        storeEditorValues(owner.id, saved.id, values!);
        storeEditorLines(owner.id, saved.id, linesBeingSaved);
      }
      for (const [index, line] of linesBeingSaved.entries()) {
        if (line.id) continue;
        const preview = linePreviews[index];
        if (!preview.input) continue;
        const lineResponse = await fetch(`/documents/${encodeURIComponent(saved.id)}/line-items`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            description: line.description,
            quantity: Number(preview.input.quantity),
            unitPriceCents: Number(preview.input.unitPriceCents),
            discountCents: Number(preview.input.discountCents),
            taxRateBasisPoints: preview.input.taxRateBasisPoints,
          }),
        });
        if (lineResponse.status === 401) {
          onAuthExpired();
          return;
        }
        if (!lineResponse.ok) {
          const error = await responseError(lineResponse);
          setServerErrors(error.fields ?? {});
          setMessage(error.message ?? 'Could not save a line item. Your input is still here.');
          storeEditorLines(owner.id, saved.id, linesBeingSaved);
          if (!documentId) navigate(`/documents/${encodeURIComponent(saved.id)}`);
          return;
        }
        const savedLine = await lineResponse.json() as { id: string };
        linesBeingSaved = linesBeingSaved.map((value, lineIndex) => lineIndex === index ? { ...value, id: savedLine.id } : value);
        storeEditorLines(owner.id, saved.id, linesBeingSaved);
      }

      const detailResponse = await fetch(`/documents/${encodeURIComponent(saved.id)}`);
      if (detailResponse.status === 401) {
        onAuthExpired();
        return;
      }
      if (!detailResponse.ok) {
        setMessage('Draft saved, but could not refresh its server totals. Reload to get current values.');
        return;
      }
      const authoritative = await detailResponse.json() as DocumentData;
      clearEditorValues(owner.id, documentId);
      clearEditorValues(owner.id, saved.id);
      setDocument(authoritative);
      setValues({ title: authoritative.title, customerName: authoritative.customerName, issueDate: authoritative.issueDate });
      setLines(lineValuesFromDocument(authoritative));
      setSubmitted(false);
      setMessage('Draft saved.');
      if (!documentId) navigate(`/documents/${encodeURIComponent(authoritative.id)}`);
    } catch {
      setMessage('Connection failed. Your input is still here. Try again.');
      if (!documentId && createdDocumentId) {
        storeEditorValues(owner.id, createdDocumentId, values!);
        storeEditorLines(owner.id, createdDocumentId, linesBeingSaved);
        navigate(`/documents/${encodeURIComponent(createdDocumentId)}`);
      }
    } finally {
      setPending(false);
    }
  }

  const amounts = document?.status === 'finalized'
    ? document.amounts
    : lines.some(line => !line.id) ? previewAmounts : document?.amounts ?? previewAmounts;

  return (
    <main className="ledger-page" data-testid="document-editor">
      <button className="back-link" type="button" onClick={() => navigate('/documents')}>← All documents</button>
      <form className="document-form" noValidate onSubmit={event => void saveDraft(event)}>
        <header className="editor-heading">
          <div className="editor-title">
            <span className="section-label">{statusLabel}</span>
            <h1>{values.title.trim() || 'Untitled document'}</h1>
            <p>Issue date {formatDate(values.issueDate)}</p>
          </div>
          <div className="editor-actions">
            <span className={`status-badge ${document?.status ?? 'unsaved'}`}>
              {!document ? 'Unsaved' : document.status === 'draft' ? 'Draft' : 'Finalized'}
            </span>
            {canEdit && <button className="primary-button" type="submit" disabled={pending}>
              {pending ? 'Saving…' : documentId ? 'Save changes' : 'Save as draft'}
            </button>}
            <button className="secondary-button print-button" type="button" onClick={() => window.print()}>Print</button>
          </div>
        </header>

        {loadError && <p className="request-error" role="alert">{loadError}</p>}
        {message && <p className={message === 'Draft saved.' ? 'success-message' : 'request-error'} role={message === 'Draft saved.' ? 'status' : 'alert'}>{message}</p>}

        <section className="metadata editor-section" aria-labelledby="metadata-heading">
          <div className="section-heading">
            <h2 id="metadata-heading">Document details</h2>
            <span>01</span>
          </div>
          <div className="metadata-fields">
            <div className="field">
              <label htmlFor="document-title">Document name</label>
              <input
                id="document-title"
                name="title"
                autoComplete="off"
                value={values.title}
                disabled={!canEdit}
                aria-invalid={Boolean(titleError)}
                aria-describedby={titleError ? 'document-title-error' : undefined}
                onChange={event => changeField('title', event.currentTarget.value)}
              />
              {titleError && <p className="field-error" id="document-title-error" role="alert">{titleError}</p>}
            </div>
            <div className="field">
              <label htmlFor="customer-name">Customer name</label>
              <input
                id="customer-name"
                name="customerName"
                autoComplete="off"
                value={values.customerName}
                disabled={!canEdit}
                onChange={event => changeField('customerName', event.currentTarget.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="issue-date">Issue date</label>
              <input
                id="issue-date"
                name="issueDate"
                type="date"
                value={values.issueDate}
                disabled={!canEdit}
                aria-invalid={Boolean(dateError)}
                aria-describedby={dateError ? 'issue-date-error' : undefined}
                onChange={event => changeField('issueDate', event.currentTarget.value)}
              />
              {dateError && <p className="field-error" id="issue-date-error" role="alert">{dateError}</p>}
            </div>
          </div>
        </section>

        <section className="line-section editor-section" aria-labelledby="line-items-heading">
          <div className="section-heading">
            <h2 id="line-items-heading">Line items</h2>
            <span>02</span>
          </div>
          {lines.length === 0 && <p className="empty-lines">No line items yet. Drafts can be saved without lines.</p>}
          {lines.map((line, index) => {
            const preview = linePreviews[index];
            const field = (name: Exclude<EditableLineField, 'description'>, label: string, inputMode: 'numeric' | 'decimal'): React.JSX.Element => {
              const error = submitted ? preview.errors[name as keyof LineInputErrors] : undefined;
              const inputId = `line-${line.key}-${name}`;
              const errorId = `${inputId}-error`;
              return (
                <div className="field" key={name}>
                  <label htmlFor={inputId}>{label}</label>
                  <input
                    id={inputId}
                    inputMode={inputMode}
                    autoComplete="off"
                    value={line[name]}
                    disabled={!canEdit || Boolean(line.id) || pending}
                    aria-invalid={Boolean(error)}
                    aria-describedby={error ? errorId : undefined}
                    onChange={event => changeLine(line.key, name, event.currentTarget.value)}
                  />
                  {error && <p className="field-error" id={errorId} role="alert">{error}</p>}
                </div>
              );
            };
            return (
              <article className="line-item" data-testid="line-item" key={line.key}>
                <div className="line-header">
                  <span className="line-index">{String(index + 1).padStart(2, '0')}</span>
                  <div className="field line-description">
                    <label className="visually-hidden" htmlFor={`line-${line.key}-description`}>Line description</label>
                    <input
                      id={`line-${line.key}-description`}
                      placeholder="Item or service"
                      value={line.description}
                      disabled={!canEdit || Boolean(line.id) || pending}
                      onChange={event => changeLine(line.key, 'description', event.currentTarget.value)}
                    />
                  </div>
                </div>
                <div className="line-fields">
                  {field('quantity', 'Qty', 'numeric')}
                  {field('unitPrice', 'Unit price €', 'decimal')}
                  {field('discount', 'Discount €', 'decimal')}
                  {field('taxRate', 'Tax %', 'decimal')}
                  <div className="line-sum">
                    <span>Line total</span>
                    <strong>{preview.amounts ? formatEuro(preview.amounts.totalCents) : '—'}</strong>
                  </div>
                </div>
                <p className="line-math">
                  {preview.amounts
                    ? `${formatEuro(preview.amounts.subtotalCents)} subtotal − ${formatEuro(preview.amounts.discountCents)} discount = ${formatEuro(preview.amounts.taxableCents)} taxable + ${formatEuro(preview.amounts.taxCents)} tax`
                    : 'Enter valid numeric values to calculate line amounts.'}
                </p>
              </article>
            );
          })}
          {canEdit && <button className="add-line" type="button" onClick={addLine}>＋ Add line item</button>}
        </section>

        <section className="breakdown editor-section" aria-labelledby="arithmetic-heading">
          <div className="section-heading">
            <h2 id="arithmetic-heading">Arithmetic</h2>
            <span>03</span>
          </div>
          <dl className="amount-list">
            <div><dt>Line subtotals</dt><dd>{amounts ? formatEuro(amounts.subtotalCents) : '—'}</dd></div>
            <div><dt>Line discounts</dt><dd>−{amounts ? formatEuro(amounts.discountCents) : '—'}</dd></div>
            <div><dt>Taxable amount</dt><dd>{amounts ? formatEuro(amounts.taxableCents) : '—'}</dd></div>
            <div><dt>Sum of line taxes</dt><dd>{amounts ? formatEuro(amounts.taxCents) : '—'}</dd></div>
          </dl>
          <div className="grand-total"><span>Document total</span><strong>{amounts ? formatEuro(amounts.totalCents) : '—'}</strong></div>
          <p className="calculation-note">Tax is rounded for each line, then summed.</p>
          {!canEdit && <p className="snapshot-note">Finalized documents are fixed snapshots.</p>}
        </section>
      </form>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<App />);

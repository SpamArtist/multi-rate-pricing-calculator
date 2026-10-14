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
type SummaryReport = {
  start: string;
  end: string;
  finalizedDocumentCount: number;
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
type PersistedEditorErrors = {
  document: FieldErrors;
  lines: Record<string, Partial<Record<EditableLineField, string>>>;
  submitted: boolean;
};
type Route = { kind: 'dashboard' } | { kind: 'new' } | { kind: 'document'; id: string };
type DashboardFilters = {
  search: string;
  status: 'all' | 'draft' | 'finalized';
  issueDateStart: string;
  issueDateEnd: string;
  sort: 'desc' | 'asc';
  page: number;
};

const EDITOR_STORAGE_PREFIX = 'pricing-calculator:editor:';

function lineStorageKey(ownerId: string, documentId?: string): string {
  return `${EDITOR_STORAGE_PREFIX}${ownerId}:${documentId ?? 'new'}:lines`;
}

function editorErrorsKey(ownerId: string, documentId?: string): string {
  return `${EDITOR_STORAGE_PREFIX}${ownerId}:${documentId ?? 'new'}:errors`;
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

function readEditorErrors(ownerId: string, documentId?: string): PersistedEditorErrors | null {
  try {
    const stored = window.sessionStorage.getItem(editorErrorsKey(ownerId, documentId));
    if (!stored) return null;
    const value = JSON.parse(stored) as Partial<PersistedEditorErrors>;
    if (!value.document || !value.lines || typeof value.submitted !== 'boolean') return null;
    return value as PersistedEditorErrors;
  } catch {
    return null;
  }
}

function storeEditorErrors(ownerId: string, documentId: string | undefined, errors: PersistedEditorErrors): void {
  try {
    window.sessionStorage.setItem(editorErrorsKey(ownerId, documentId), JSON.stringify(errors));
  } catch {
    // Live form state remains available when browser storage is unavailable.
  }
}

function clearEditorErrors(ownerId: string, documentId?: string): void {
  try {
    window.sessionStorage.removeItem(editorErrorsKey(ownerId, documentId));
  } catch {
    // Nothing to clear when browser storage is unavailable.
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

function previewLine(line: LineValues, useSnapshot = false): LinePreview {
  if (useSnapshot && line.amounts) return { errors: {}, amounts: line.amounts };

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

function localMonthRange(): { start: string; end: string } {
  const today = new Date();
  const year = today.getFullYear();
  const month = today.getMonth();
  const monthString = String(month + 1).padStart(2, '0');
  const lastDay = new Date(year, month + 1, 0).getDate();
  return {
    start: `${year}-${monthString}-01`,
    end: `${year}-${monthString}-${String(lastDay).padStart(2, '0')}`,
  };
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
    clearEditorErrors(ownerId, documentId);
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

function lineFieldErrors(fields?: FieldErrors): Partial<Record<EditableLineField, string>> {
  if (!fields) return {};
  return {
    ...(fields.description ? { description: fields.description } : {}),
    ...(fields.quantity ? { quantity: fields.quantity } : {}),
    ...(fields.unitPriceCents ? { unitPrice: fields.unitPriceCents } : {}),
    ...(fields.discountCents ? { discount: fields.discountCents } : {}),
    ...(fields.taxRateBasisPoints ? { taxRate: fields.taxRateBasisPoints } : {}),
  };
}

function splitFinalizationErrors(
  fields: FieldErrors,
  lines: LineValues[],
): { document: FieldErrors; lines: Record<string, Partial<Record<EditableLineField, string>>> } {
  const document: FieldErrors = {};
  const lineErrors: Record<string, Partial<Record<EditableLineField, string>>> = {};
  const fieldNames: Record<string, EditableLineField> = {
    description: 'description',
    quantity: 'quantity',
    unitPriceCents: 'unitPrice',
    discountCents: 'discount',
    taxRateBasisPoints: 'taxRate',
  };

  for (const [path, message] of Object.entries(fields)) {
    const match = /^lineItems\[(\d+)\]\.([A-Za-z]+)$/.exec(path);
    if (!match) {
      document[path] = message;
      continue;
    }
    const line = lines[Number(match[1])];
    const field = fieldNames[match[2]];
    if (!line || !field) {
      document[path] = message;
      continue;
    }
    lineErrors[line.key] = { ...lineErrors[line.key], [field]: message };
  }
  return { document, lines: lineErrors };
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
          <a className="nav-link active" href="#/documents" aria-current="page">Documents</a>
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
  const [totalPages, setTotalPages] = React.useState(0);
  const [filters, setFilters] = React.useState<DashboardFilters>({
    search: '',
    status: 'all',
    issueDateStart: '',
    issueDateEnd: '',
    sort: 'desc',
    page: 1,
  });
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState('');
  const [reportOpen, setReportOpen] = React.useState(false);
  const [reportRange, setReportRange] = React.useState(localMonthRange);
  const [reportSummary, setReportSummary] = React.useState<SummaryReport | null>(null);
  const [reportLoading, setReportLoading] = React.useState(false);
  const [reportError, setReportError] = React.useState('');
  const reportRangeError = !isCalendarDate(reportRange.start) || !isCalendarDate(reportRange.end)
    ? 'Enter both report dates.'
    : reportRange.start > reportRange.end
      ? 'End date must be on or after start date.'
      : '';

  React.useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const params = new URLSearchParams();
    if (filters.search) params.set('search', filters.search);
    if (filters.status !== 'all') params.set('status', filters.status);
    if (filters.issueDateStart) params.set('issueDateStart', filters.issueDateStart);
    if (filters.issueDateEnd) params.set('issueDateEnd', filters.issueDateEnd);
    if (filters.sort !== 'desc') params.set('sort', filters.sort);
    if (filters.page > 1) params.set('page', String(filters.page));
    const query = params.toString();

    setLoading(true);
    setError('');
    void fetch(`/documents${query ? `?${query}` : ''}`, { signal: controller.signal })
      .then(async response => {
        if (response.status === 401) {
          onAuthExpired();
          return null;
        }
        if (!response.ok) throw new Error((await responseError(response)).message ?? 'Could not load documents.');
        return response.json() as Promise<{
          items: DocumentSummary[];
          page: number;
          pageSize: number;
          totalItems: number;
          totalPages: number;
        }>;
      })
      .then(result => {
        if (!active || !result) return;
        setItems(result.items);
        setTotalItems(result.totalItems);
        setTotalPages(result.totalPages);
      })
      .catch((reason: unknown) => {
        if (!active || (reason instanceof DOMException && reason.name === 'AbortError')) return;
        setItems([]);
        setTotalItems(0);
        setTotalPages(0);
        setError(reason instanceof Error ? reason.message : 'Could not load documents.');
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [filters, onAuthExpired, user.id]);

  React.useEffect(() => {
    if (!reportOpen) return undefined;
    if (reportRangeError) {
      setReportSummary(null);
      setReportLoading(false);
      setReportError('');
      return undefined;
    }

    let active = true;
    const controller = new AbortController();
    const query = new URLSearchParams({ start: reportRange.start, end: reportRange.end });
    setReportLoading(true);
    setReportError('');
    void fetch(`/reports/summary?${query}`, { signal: controller.signal })
      .then(async response => {
        if (response.status === 401) {
          onAuthExpired();
          return null;
        }
        if (!response.ok) {
          const result = await responseError(response);
          throw new Error(result.message ?? 'Could not load summary.');
        }
        return response.json() as Promise<SummaryReport>;
      })
      .then(result => {
        if (active && result) setReportSummary(result);
      })
      .catch((reason: unknown) => {
        if (!active || (reason instanceof DOMException && reason.name === 'AbortError')) return;
        setReportSummary(null);
        setReportError(reason instanceof Error ? reason.message : 'Could not load summary.');
      })
      .finally(() => { if (active) setReportLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [onAuthExpired, reportOpen, reportRange.end, reportRange.start, reportRangeError, user.id]);

  const updateFilters = (changes: Partial<DashboardFilters>): void => {
    setFilters(current => ({ ...current, ...changes, page: 1 }));
  };
  const hasActiveFilters = Boolean(
    filters.search.trim()
    || filters.status !== 'all'
    || filters.issueDateStart
    || filters.issueDateEnd
    || filters.sort !== 'desc',
  );
  const visiblePageNumbers = paginationPages(filters.page, totalPages);
  const currentReport = reportSummary?.start === reportRange.start && reportSummary.end === reportRange.end
    ? reportSummary
    : null;

  return (
    <div className={`dashboard-layout${reportOpen ? ' summary-open' : ''}`}>
    <main className="dashboard-page">
      <div className="page-heading">
        <div className="dashboard-intro">
          <p className="eyebrow">Pricing documents</p>
          <h1>Documents</h1>
          <p className="dashboard-subtitle">Find and continue your customer work.</p>
        </div>
        <div className="dashboard-actions">
          <button
            className="secondary-button summary-action"
            type="button"
            aria-controls="summary-report-sidebar"
            aria-expanded={reportOpen}
            onClick={() => setReportOpen(true)}
          >
            <svg aria-hidden="true" viewBox="0 0 20 20"><path d="M3 16.5h14M5.5 13V8m4 5V4m4 9v-3" /></svg>
            Generate Summary
          </button>
          <button className="primary-button new-document-action" type="button" onClick={() => navigate('/documents/new')}>
            <svg aria-hidden="true" viewBox="0 0 20 20"><path d="M10 3.5v13M3.5 10h13" /></svg>
            New document
          </button>
        </div>
      </div>

      <section className="document-list-section" aria-labelledby="document-list-title">
        <div className="section-heading list-heading">
          <h2 id="document-list-title">All documents</h2>
          <span aria-live="polite">{loading ? 'Loading…' : totalItems === 0 ? '0 documents' : `${totalItems} shown`}</span>
        </div>
        {error && <p className="request-error" role="alert">{error}</p>}
        <form className="dashboard-filters" role="search" onSubmit={event => event.preventDefault()}>
          <label className="search-control">
            <span className="visually-hidden">Search customers</span>
            <svg aria-hidden="true" viewBox="0 0 20 20"><circle cx="8.5" cy="8.5" r="5.5" /><path d="m12.5 12.5 4 4" /></svg>
            <input
              type="search"
              aria-label="Search customers"
              placeholder="Search customers"
              value={filters.search}
              onChange={event => updateFilters({ search: event.currentTarget.value })}
            />
          </label>
          <label className="filter-select">
            <span className="visually-hidden">Status</span>
            <select aria-label="Status" value={filters.status} onChange={event => updateFilters({ status: event.currentTarget.value as DashboardFilters['status'] })}>
              <option value="all">All statuses</option>
              <option value="draft">Drafts</option>
              <option value="finalized">Finalized</option>
            </select>
          </label>
          <label className="filter-select">
            <span className="visually-hidden">Sort by issue date</span>
            <select aria-label="Sort by issue date" value={filters.sort} onChange={event => updateFilters({ sort: event.currentTarget.value as DashboardFilters['sort'] })}>
              <option value="desc">Newest first</option>
              <option value="asc">Oldest first</option>
            </select>
          </label>
          <label className="date-filter">
            <span>From</span>
            <input aria-label="From issue date" type="date" value={filters.issueDateStart} onChange={event => updateFilters({ issueDateStart: event.currentTarget.value })} />
          </label>
          <label className="date-filter">
            <span>To</span>
            <input aria-label="To issue date" type="date" value={filters.issueDateEnd} onChange={event => updateFilters({ issueDateEnd: event.currentTarget.value })} />
          </label>
          {hasActiveFilters && (
            <button className="reset-filters" type="button" onClick={() => setFilters({
              search: '', status: 'all', issueDateStart: '', issueDateEnd: '', sort: 'desc', page: 1,
            })}>
              Clear filters
            </button>
          )}
        </form>
        {loading ? (
          <p className="empty-state" aria-live="polite">Loading your documents…</p>
        ) : items.length === 0 ? (
          hasActiveFilters ? (
            <div className="empty-state">
              <p>No documents match these filters.</p>
              <button className="text-button" type="button" onClick={() => setFilters({
                search: '', status: 'all', issueDateStart: '', issueDateEnd: '', sort: 'desc', page: 1,
              })}>
                Clear filters
              </button>
            </div>
          ) : (
            <div className="empty-state">
              <p>No documents yet.</p>
              <p>Start with a name and issue date. Add customer details when ready.</p>
            </div>
          )
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
                    <td className="number-cell"><span className="row-total"><span>{formatEuro(item.amounts.totalCents)}</span><span className="row-arrow" aria-hidden="true">→</span></span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {!loading && totalPages > 0 && (
          <nav className="document-pagination" aria-label="Document pages">
            <button type="button" aria-label="Previous page" disabled={filters.page <= 1} onClick={() => setFilters(current => ({ ...current, page: current.page - 1 }))}>←</button>
            {visiblePageNumbers.map((pageNumber, index) => typeof pageNumber === 'number' ? (
              <button
                type="button"
                key={pageNumber}
                aria-label={`Page ${pageNumber}`}
                aria-current={pageNumber === filters.page ? 'page' : undefined}
                onClick={() => setFilters(current => ({ ...current, page: pageNumber }))}
              >
                {pageNumber}
              </button>
            ) : <span className="page-ellipsis" key={`ellipsis-${index}`} aria-hidden="true">…</span>)}
            <button type="button" aria-label="Next page" disabled={filters.page >= totalPages} onClick={() => setFilters(current => ({ ...current, page: current.page + 1 }))}>→</button>
          </nav>
        )}
      </section>
    </main>
    <aside
      id="summary-report-sidebar"
      className="summary-sidebar"
      aria-label="Summary report"
      hidden={!reportOpen}
    >
      <div className="summary-sidebar-head">
        <span>Generated summary</span>
        <button className="summary-close" type="button" aria-label="Close summary" onClick={() => setReportOpen(false)}>×</button>
      </div>
      <section className="summary-report" aria-label="Summary report">
        <div className="summary-report-heading">
          <div>
            <span className="summary-label">Summary report</span>
            <h2>Issue date totals</h2>
          </div>
          <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 20h16M7 16V9m5 7V4m5 12v-5" /></svg>
        </div>
        <div className="summary-date-fields">
          <label>
            <span>From</span>
            <input
              aria-label="Summary start date"
              aria-invalid={Boolean(reportRangeError)}
              aria-describedby={reportRangeError ? 'summary-range-error' : undefined}
              type="date"
              value={reportRange.start}
              onChange={event => {
                const start = event.currentTarget.value;
                setReportRange(current => ({ ...current, start }));
              }}
            />
          </label>
          <label>
            <span>To</span>
            <input
              aria-label="Summary end date"
              aria-invalid={Boolean(reportRangeError)}
              aria-describedby={reportRangeError ? 'summary-range-error' : undefined}
              type="date"
              value={reportRange.end}
              onChange={event => {
                const end = event.currentTarget.value;
                setReportRange(current => ({ ...current, end }));
              }}
            />
          </label>
        </div>
        {reportRangeError ? (
          <p className="field-error summary-range-error" id="summary-range-error" role="alert">{reportRangeError}</p>
        ) : reportError ? (
          <p className="request-error" role="alert">{reportError}</p>
        ) : (
          <p className="summary-report-note">Finalized documents only · independent of list filters</p>
        )}
        <div className="summary-report-major" aria-live="polite">
          <span>Total</span>
          <strong>{currentReport ? formatEuro(currentReport.amounts.totalCents) : '—'}</strong>
        </div>
        <dl className="summary-amount-list">
          <div><dt>Documents</dt><dd>{currentReport ? currentReport.finalizedDocumentCount : reportLoading ? 'Loading…' : '—'}</dd></div>
          <div><dt>Subtotal</dt><dd>{currentReport ? formatEuro(currentReport.amounts.subtotalCents) : '—'}</dd></div>
          <div><dt>Discounts</dt><dd>{currentReport ? `−${formatEuro(currentReport.amounts.discountCents)}` : '—'}</dd></div>
          <div><dt>Taxable</dt><dd>{currentReport ? formatEuro(currentReport.amounts.taxableCents) : '—'}</dd></div>
          <div><dt>Tax</dt><dd>{currentReport ? formatEuro(currentReport.amounts.taxCents) : '—'}</dd></div>
        </dl>
      </section>
    </aside>
    </div>
  );
}

function paginationPages(current: number, total: number): Array<number | 'ellipsis'> {
  if (total <= 7) return Array.from({ length: total }, (_, index) => index + 1);
  const pages = new Set([1, total, current - 1, current, current + 1]);
  const ordered = [...pages].filter(page => page >= 1 && page <= total).sort((left, right) => left - right);
  const result: Array<number | 'ellipsis'> = [];
  for (const [index, page] of ordered.entries()) {
    if (index > 0 && page - ordered[index - 1] > 1) result.push('ellipsis');
    result.push(page);
  }
  return result;
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
  const [removedLineIds, setRemovedLineIds] = React.useState<string[]>([]);
  const [loading, setLoading] = React.useState(Boolean(documentId));
  const [loadError, setLoadError] = React.useState('');
  const [serverErrors, setServerErrors] = React.useState<FieldErrors>({});
  const [serverLineErrors, setServerLineErrors] = React.useState<Record<string, Partial<Record<EditableLineField, string>>>>({});
  const [message, setMessage] = React.useState('');
  const [duplicateCopyId, setDuplicateCopyId] = React.useState<string | null>(null);
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
        const recoveredLineIds = new Set(recoveredLines?.flatMap(line => line.id ? [line.id] : []) ?? []);
        const recoveredSavedLines = recoveredLines?.filter(line => line.id && savedIds.has(line.id)) ?? [];
        const savedById = new Map(savedLines.flatMap(line => line.id ? [[line.id, line] as const] : []));
        const restoredSavedLines = recoveredSavedLines.flatMap(line => {
          const saved = savedById.get(line.id!);
          return saved ? [{ ...saved, ...line, amounts: saved.amounts }] : [];
        });
        const restoredSavedIds = new Set(restoredSavedLines.map(line => line.id));
        const remainingSavedLines = savedLines.filter(line => !restoredSavedIds.has(line.id)
          && (!recoveredLines || Boolean(line.id && recoveredLineIds.has(line.id))));
        const unsavedLines = recoveredLines?.filter(line => !line.id || !savedIds.has(line.id)) ?? [];
        setLines([...restoredSavedLines, ...remainingSavedLines, ...unsavedLines]);
        const recoveredErrors = readEditorErrors(owner.id, documentId);
        if (recoveredErrors) {
          setServerErrors(recoveredErrors.document);
          setServerLineErrors(recoveredErrors.lines);
          setSubmitted(recoveredErrors.submitted);
        }
        if (recoveredLines) {
          setRemovedLineIds(savedLines.flatMap(line => line.id && !recoveredLineIds.has(line.id) ? [line.id] : []));
        }
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
  const linePreviews = lines.map(line => previewLine(line, document?.status === 'finalized'));
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
  const customerError = serverErrors.customerName;
  const lineItemsError = serverErrors.lineItems;
  const canEdit = !document || document.status === 'draft';
  const statusLabel = !document ? 'Unsaved document' : document.status === 'draft' ? 'Editable draft' : 'Fixed snapshot';

  function changeField(field: keyof DocumentValues, value: string): void {
    const next = { ...values!, [field]: value };
    setValues(next);
    storeEditorValues(owner.id, documentId, next);
    clearEditorErrors(owner.id, documentId);
    setServerErrors(current => {
      const updated = { ...current };
      delete updated[field];
      return updated;
    });
    setMessage('');
  }

  function changeLine(key: string, field: EditableLineField, value: string): void {
    const next = lines.map(line => line.key === key ? { ...line, [field]: value } : line);
    setLines(next);
    storeEditorLines(owner.id, documentId, next);
    clearEditorErrors(owner.id, documentId);
    setServerLineErrors(current => {
      const updated = { ...current };
      delete updated[key];
      return updated;
    });
    setMessage('');
  }

  function moveLine(key: string, direction: -1 | 1): void {
    const index = lines.findIndex(line => line.key === key);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= lines.length) return;
    const next = [...lines];
    [next[index], next[target]] = [next[target], next[index]];
    setLines(next);
    storeEditorLines(owner.id, documentId, next);
    setMessage('');
  }

  function removeLine(key: string): void {
    const removed = lines.find(line => line.key === key);
    if (!removed) return;
    if (removed.id) setRemovedLineIds(current => current.includes(removed.id!) ? current : [...current, removed.id!]);
    const next = lines.filter(line => line.key !== key);
    setLines(next);
    storeEditorLines(owner.id, documentId, next);
    clearEditorErrors(owner.id, documentId);
    setServerLineErrors(current => {
      const updated = { ...current };
      delete updated[key];
      return updated;
    });
    setMessage('');
  }

  function addLine(): void {
    const next = [...lines, newLineValues()];
    setLines(next);
    storeEditorLines(owner.id, documentId, next);
    clearEditorErrors(owner.id, documentId);
    setServerErrors(current => {
      const updated = { ...current };
      delete updated.lineItems;
      return updated;
    });
    setSubmitted(false);
    setMessage('');
  }

  async function saveDraft(finalizeAfterSave = false): Promise<void> {
    setSubmitted(true);
    setMessage('');
    clearEditorErrors(owner.id, documentId);
    const errors = documentFieldErrors(values!);
    setServerErrors({});
    setServerLineErrors({});
    if (Object.keys(errors).length > 0) return;
    if ((hasLineErrors || !previewAmounts) && !finalizeAfterSave) {
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

      for (const [index, line] of linesBeingSaved.entries()) {
        if (!line.id) continue;
        const preview = linePreviews[index];
        if (!preview.input) continue;
        const lineResponse = await fetch(`/documents/${encodeURIComponent(saved.id)}/line-items/${encodeURIComponent(line.id)}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            description: line.description,
            quantity: Number(preview.input.quantity),
            unitPriceCents: Number(preview.input.unitPriceCents),
            discountCents: Number(preview.input.discountCents),
            taxRateBasisPoints: preview.input.taxRateBasisPoints,
            position: index + 1,
          }),
        });
        if (lineResponse.status === 401) {
          onAuthExpired();
          return;
        }
        if (!lineResponse.ok) {
          const error = await responseError(lineResponse);
          setServerLineErrors(current => ({ ...current, [line.key]: lineFieldErrors(error.fields) }));
          setMessage(error.message ?? 'Could not save a line item. Your input is still here.');
          storeEditorLines(owner.id, saved.id, linesBeingSaved);
          if (!documentId) navigate(`/documents/${encodeURIComponent(saved.id)}`);
          return;
        }
        storeEditorLines(owner.id, saved.id, linesBeingSaved);
      }

      for (const removedId of removedLineIds) {
        const lineResponse = await fetch(`/documents/${encodeURIComponent(saved.id)}/line-items/${encodeURIComponent(removedId)}`, {
          method: 'DELETE',
        });
        if (lineResponse.status === 401) {
          onAuthExpired();
          return;
        }
        if (!lineResponse.ok && lineResponse.status !== 404) {
          const error = await responseError(lineResponse);
          setMessage(error.message ?? 'Could not remove a line item. Your other input is still here.');
          storeEditorLines(owner.id, saved.id, linesBeingSaved);
          if (!documentId) navigate(`/documents/${encodeURIComponent(saved.id)}`);
          return;
        }
      }

      if (finalizeAfterSave && (hasLineErrors || !previewAmounts)) {
        const detailResponse = await fetch(`/documents/${encodeURIComponent(saved.id)}`);
        if (detailResponse.status === 401) {
          onAuthExpired();
          return;
        }
        if (!detailResponse.ok) {
          setMessage('Draft saved, but could not refresh its server values. Reload to get current values.');
          return;
        }
        const authoritative = await detailResponse.json() as DocumentData;
        if (!documentId) clearEditorValues(owner.id);
        setDocument(authoritative);
        setValues({ title: authoritative.title, customerName: authoritative.customerName, issueDate: authoritative.issueDate });
        setLines(linesBeingSaved);
        setRemovedLineIds([]);
        setServerLineErrors({});
        setSubmitted(true);
        setMessage(hasLineErrors ? 'Fix line item fields before finalizing. Draft saved.' : 'Draft saved. Correct amounts before finalizing.');
        storeEditorValues(owner.id, saved.id, {
          title: authoritative.title, customerName: authoritative.customerName, issueDate: authoritative.issueDate,
        });
        storeEditorLines(owner.id, saved.id, linesBeingSaved);
        storeEditorErrors(owner.id, saved.id, { document: {}, lines: {}, submitted: true });
        if (!documentId) navigate(`/documents/${encodeURIComponent(authoritative.id)}`);
        return;
      }

      let finalizedDocument: DocumentData | undefined;
      if (finalizeAfterSave) {
        const finalizeResponse = await fetch(`/documents/${encodeURIComponent(saved.id)}/finalize`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        });
        if (finalizeResponse.status === 401) {
          onAuthExpired();
          return;
        }
        if (!finalizeResponse.ok) {
          const error = await responseError(finalizeResponse);
          if (finalizeResponse.status === 422 && error.fields) {
            const splitErrors = splitFinalizationErrors(error.fields, linesBeingSaved);
            setServerErrors(splitErrors.document);
            setServerLineErrors(splitErrors.lines);
            storeEditorErrors(owner.id, saved.id, {
              document: splitErrors.document,
              lines: splitErrors.lines,
              submitted: true,
            });
          }
          const detailResponse = await fetch(`/documents/${encodeURIComponent(saved.id)}`);
          if (detailResponse.status === 401) {
            onAuthExpired();
            return;
          }
          if (detailResponse.ok) {
            const current = await detailResponse.json() as DocumentData;
            if (!documentId) clearEditorValues(owner.id);
            setDocument(current);
            setValues({ title: current.title, customerName: current.customerName, issueDate: current.issueDate });
            setLines(current.status === 'draft' ? linesBeingSaved : lineValuesFromDocument(current));
            setRemovedLineIds([]);
            storeEditorValues(owner.id, saved.id, {
              title: current.title, customerName: current.customerName, issueDate: current.issueDate,
            });
            storeEditorLines(owner.id, saved.id, current.status === 'draft' ? linesBeingSaved : lineValuesFromDocument(current));
          }
          setSubmitted(true);
          setMessage(error.message ?? 'Could not finalize this document. Your draft stays editable.');
          if (!documentId) navigate(`/documents/${encodeURIComponent(saved.id)}`);
          return;
        }
        finalizedDocument = await finalizeResponse.json() as DocumentData;
      }

      let authoritative = finalizedDocument;
      if (!authoritative) {
        const detailResponse = await fetch(`/documents/${encodeURIComponent(saved.id)}`);
        if (detailResponse.status === 401) {
          onAuthExpired();
          return;
        }
        if (!detailResponse.ok) {
          setMessage('Draft saved, but could not refresh its server totals. Reload to get current values.');
          return;
        }
        authoritative = await detailResponse.json() as DocumentData;
      }
      clearEditorValues(owner.id, documentId);
      clearEditorValues(owner.id, saved.id);
      setDocument(authoritative);
      setValues({ title: authoritative.title, customerName: authoritative.customerName, issueDate: authoritative.issueDate });
      setLines(lineValuesFromDocument(authoritative));
      setRemovedLineIds([]);
      setServerLineErrors({});
      setSubmitted(false);
      setServerErrors({});
      setMessage(finalizeAfterSave ? 'Document finalized. This snapshot cannot be changed.' : 'Draft saved.');
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

  async function duplicateDocument(): Promise<void> {
    if (!documentId || !document || pending) return;
    setPending(true);
    setMessage('');
    setDuplicateCopyId(null);
    try {
      const response = await fetch(`/documents/${encodeURIComponent(documentId)}/duplicate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ issueDate: localToday() }),
      });
      if (response.status === 401) {
        onAuthExpired();
        return;
      }
      const result = await response.json() as DocumentData | { error?: { message?: string } };
      if (!response.ok) {
        setMessage((result as { error?: { message?: string } }).error?.message ?? 'Could not duplicate this document.');
        return;
      }
      const copy = result as DocumentData;
      setDuplicateCopyId(copy.id);
      setMessage('Draft duplicated.');
    } catch {
      setMessage('Connection failed. Source document stays open. Try again.');
    } finally {
      setPending(false);
    }
  }

  async function deleteDraft(): Promise<void> {
    if (!documentId || !document || document.status !== 'draft' || pending) return;
    if (!window.confirm('Delete this draft and all its lines permanently?')) return;

    setPending(true);
    setMessage('');
    try {
      const response = await fetch(`/documents/${encodeURIComponent(documentId)}`, { method: 'DELETE' });
      if (response.status === 401) {
        onAuthExpired();
        return;
      }
      if (response.status === 404 || response.status === 409) {
        navigate('/documents');
        return;
      }
      if (!response.ok) {
        const error = await responseError(response);
        setMessage(error.message ?? 'Could not delete this draft. Try again.');
        return;
      }
      clearEditorValues(owner.id, documentId);
      navigate('/documents');
    } catch {
      setMessage('Connection failed. Draft stays saved. Try again.');
    } finally {
      setPending(false);
    }
  }

  const amounts = document?.status === 'finalized'
    ? document.amounts
    : previewAmounts;

  return (
    <main className="ledger-page" data-testid="document-editor">
      <button className="back-link" type="button" onClick={() => navigate('/documents')}>← All documents</button>
      <form className="document-form" noValidate onSubmit={event => { event.preventDefault(); void saveDraft(); }}>
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
            {canEdit && <button
              className="secondary-button"
              type="button"
              disabled={pending}
              onClick={() => void saveDraft(true)}
            >{pending ? 'Finalizing…' : 'Finalize document'}</button>}
            {document && <button
              className="secondary-button"
              type="button"
              disabled={pending}
              onClick={() => void duplicateDocument()}
            >{pending ? 'Working…' : 'Duplicate'}</button>}
            {document?.status === 'draft' && <button
              className="secondary-button danger-button"
              type="button"
              disabled={pending}
              onClick={() => void deleteDraft()}
            >{pending ? 'Deleting…' : 'Delete draft'}</button>}
            <button className="secondary-button print-button" type="button" onClick={() => window.print()}>Print</button>
          </div>
        </header>

        {loadError && <p className="request-error" role="alert">{loadError}</p>}
        {message && <p
          className={message === 'Draft saved.' || message === 'Draft duplicated.' || message.startsWith('Document finalized.') ? 'success-message' : 'request-error'}
          role={message === 'Draft saved.' || message === 'Draft duplicated.' || message.startsWith('Document finalized.') ? 'status' : 'alert'}
        >{message}</p>}
        {duplicateCopyId && <a className="back-link" href={`#/documents/${encodeURIComponent(duplicateCopyId)}`}>Open copy →</a>}

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
                aria-invalid={Boolean(customerError)}
                aria-describedby={customerError ? 'customer-name-error' : undefined}
                onChange={event => changeField('customerName', event.currentTarget.value)}
              />
              {customerError && <p className="field-error" id="customer-name-error" role="alert">{customerError}</p>}
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
          {lineItemsError && <p className="field-error" role="alert">{lineItemsError}</p>}
          {lines.map((line, index) => {
            const preview = linePreviews[index];
            const field = (name: Exclude<EditableLineField, 'description'>, label: string, inputMode: 'numeric' | 'decimal'): React.JSX.Element => {
              const error = serverLineErrors[line.key]?.[name]
                ?? (submitted ? preview.errors[name as keyof LineInputErrors] : undefined);
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
                    disabled={!canEdit || pending}
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
                      disabled={!canEdit || pending}
                      aria-invalid={Boolean(serverLineErrors[line.key]?.description)}
                      aria-describedby={serverLineErrors[line.key]?.description ? `line-${line.key}-description-error` : undefined}
                      onChange={event => changeLine(line.key, 'description', event.currentTarget.value)}
                    />
                    {serverLineErrors[line.key]?.description && <p className="field-error" id={`line-${line.key}-description-error`} role="alert">{serverLineErrors[line.key].description}</p>}
                  </div>
                  {canEdit && <div className="line-actions" aria-label={`Line ${index + 1} actions`}>
                    <button
                      className="line-action"
                      type="button"
                      aria-label={`Move line ${index + 1} up`}
                      disabled={pending || index === 0}
                      onClick={() => moveLine(line.key, -1)}
                    >↑</button>
                    <button
                      className="line-action"
                      type="button"
                      aria-label={`Move line ${index + 1} down`}
                      disabled={pending || index === lines.length - 1}
                      onClick={() => moveLine(line.key, 1)}
                    >↓</button>
                    <button
                      className="line-action remove-line"
                      type="button"
                      aria-label={`Remove line ${index + 1}`}
                      disabled={pending}
                      onClick={() => removeLine(line.key)}
                    >×</button>
                  </div>}
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

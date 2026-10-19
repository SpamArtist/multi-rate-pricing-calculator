import type {
  DuplicationBrowserAction, DuplicationBrowserRecord, DuplicationBrowserStage,
} from './duplication-diagnostics.types.js';

const enabled = import.meta.env.VITE_DUPLICATION_TRACE === '1';
const records: DuplicationBrowserRecord[] = [];
let pendingCopyOpen: DuplicationBrowserAction | undefined;

if (enabled) Object.defineProperty(window, '__duplicationDiagnostics', { value: records, configurable: true });

export function beginDuplicationDiagnostic(interaction: DuplicationBrowserRecord['interaction']): DuplicationBrowserAction | undefined {
  if (!enabled) return undefined;
  const action = { startedAt: performance.now(), record: { interaction, stages: [] } };
  markDuplicationDiagnostic(action, 'invoked');
  return action;
}

export function markDuplicationDiagnostic(action: DuplicationBrowserAction | undefined, stage: DuplicationBrowserStage): void {
  if (!action) return;
  action.record.stages.push({ stage, elapsedMs: +(performance.now() - action.startedAt).toFixed(3) });
}

export function setDuplicationResponse(action: DuplicationBrowserAction | undefined, response: Response): void {
  if (!action) return;
  action.record.status = response.status;
  const id = response.headers.get('x-duplication-request-id');
  if (id && /^[0-9a-f-]{36}$/i.test(id)) action.record.requestId = id;
}

export function finishDuplicationDiagnostic(
  action: DuplicationBrowserAction | undefined, outcome: NonNullable<DuplicationBrowserRecord['outcome']>,
): void {
  if (!action) return;
  action.record.outcome = outcome;
  records.push(action.record);
  if (records.length > 100) records.splice(0, records.length - 100);
}

export function beginOpenCopyDiagnostic(): void {
  pendingCopyOpen = beginDuplicationDiagnostic('open-copy');
}

export function takeOpenCopyDiagnostic(): DuplicationBrowserAction | undefined {
  const action = pendingCopyOpen;
  pendingCopyOpen = undefined;
  return action;
}

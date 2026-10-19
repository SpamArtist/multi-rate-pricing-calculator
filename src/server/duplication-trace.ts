import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { RequestHandler, Response } from 'express';
import type { DuplicationSpan, DuplicationSpanName, DuplicationTraceRecord } from './duplication-trace.types.js';

const enabled = process.env.PRICING_DUPLICATION_TRACE === '1';
const outputFile = resolve(process.env.PRICING_DUPLICATION_TRACE_FILE ?? '.artifacts/duplication-traces.ndjson');
const maxRecords = 2_000;
const maxSpans = 31;
const maxFileBytes = 10 * 1024 * 1024;
const safeLabel = (value: string | undefined): string | undefined =>
  value && /^[a-zA-Z0-9_-]{1,48}$/.test(value) ? value : undefined;
const runId = safeLabel(process.env.PRICING_DUPLICATION_RUN_ID);
const configuredVariant = safeLabel(process.env.PRICING_DUPLICATION_VARIANT);
let accepted = 0;
let dropped = 0;
let pending = Promise.resolve();
const active = new WeakMap<Response, DuplicationTrace>();

function reportDrop(message: string): void {
  dropped += 1;
  if (dropped === 1) {
    try { process.stderr.write(`[duplication-trace] ${message}; traces dropped\n`); } catch { /* Diagnostic only. */ }
  }
}

const parentOf = (name: DuplicationSpanName): DuplicationSpan['parent'] =>
  name === 'request.total' ? null
    : name === 'auth.session' || name === 'duplicate.validate' || name === 'transaction.total'
    || name === 'response.encode_send' ? 'request.total' : 'transaction.total';

function bucket(count: number): DuplicationTraceRecord['lineCountBucket'] {
  return count === 0 ? '0' : count < 10 ? '1-9' : count < 100 ? '10-99' : count < 500 ? '100-499' : '500+';
}

function persist(record: DuplicationTraceRecord): void {
  if (accepted >= maxRecords) {
    reportDrop('record limit reached');
    return;
  }
  accepted += 1;
  const line = `${JSON.stringify(record)}\n`;
  pending = pending.then(async () => {
    await mkdir(dirname(outputFile), { recursive: true });
    const existingBytes = await stat(outputFile).then(info => info.size, () => 0);
    if (existingBytes + Buffer.byteLength(line) > maxFileBytes) throw new Error('trace file limit');
    await appendFile(outputFile, line, { mode: 0o600 });
  }).catch(() => {
    reportDrop('output failed');
  });
}

export class DuplicationTrace {
  readonly requestId = randomUUID();
  readonly startedAt = performance.now();
  readonly spans: DuplicationSpan[] = [];
  queryCount = 0;
  copiedRows?: number;
  sourceState?: DuplicationTraceRecord['sourceState'];
  variant?: string;
  lineCountBucket?: DuplicationTraceRecord['lineCountBucket'];

  add(name: DuplicationSpanName, start: number, outcome: DuplicationSpan['outcome'] = 'ok'): void {
    if (this.spans.length >= maxSpans) return;
    try {
      this.spans.push({ name, parent: parentOf(name), startMs: +(start - this.startedAt).toFixed(3),
        durationMs: +(performance.now() - start).toFixed(3), outcome });
    } catch { reportDrop('span recording failed'); }
  }

  async measure<T>(name: DuplicationSpanName, operation: () => Promise<T>, query = false): Promise<T> {
    const start = performance.now();
    if (query) this.queryCount += 1;
    try {
      const result = await operation();
      this.add(name, start);
      return result;
    } catch (error) {
      this.add(name, start, 'error');
      throw error;
    }
  }

  measureSync<T>(name: DuplicationSpanName, operation: () => T): T {
    const start = performance.now();
    try {
      const result = operation();
      this.add(name, start);
      return result;
    } catch (error) {
      this.add(name, start, 'error');
      throw error;
    }
  }

  setLineCount(count: number): void { this.lineCountBucket = bucket(count); }

  finish(response: Response, outcome: DuplicationTraceRecord['outcome']): void {
    active.delete(response);
    try {
      const totalMs = +(performance.now() - this.startedAt).toFixed(3);
      persist({ requestId: this.requestId, runId, variant: this.variant ?? configuredVariant,
        route: 'POST /documents/:id/duplicate', status: response.statusCode,
        outcome, totalMs, sourceState: this.sourceState,
        lineCountBucket: this.lineCountBucket, copiedRows: this.copiedRows,
        queryCount: this.queryCount, responseBytes: Number(response.getHeader('content-length')) || undefined,
        spans: [{ name: 'request.total', parent: null, startMs: 0, durationMs: totalMs,
          outcome: outcome === 'finish' ? 'ok' : 'error' }, ...this.spans] });
    } catch { reportDrop('recording failed'); }
  }
}

export function traceFor(response: Response): DuplicationTrace | undefined { return active.get(response); }

export function measureDuplication<T>(
  trace: DuplicationTrace | undefined, name: DuplicationSpanName, operation: () => Promise<T>, query = false,
): Promise<T> {
  return trace ? trace.measure(name, operation, query) : operation();
}

export function measureDuplicationSync<T>(
  trace: DuplicationTrace | undefined, name: DuplicationSpanName, operation: () => T,
): T {
  return trace ? trace.measureSync(name, operation) : operation();
}

export const duplicationTraceMiddleware: RequestHandler = (request, response, next) => {
  if (!enabled || request.method !== 'POST' || !/^\/documents\/[^/]+\/duplicate$/.test(request.path)) {
    next();
    return;
  }
  try {
    const trace = new DuplicationTrace();
    active.set(response, trace);
    response.setHeader('X-Duplication-Request-Id', trace.requestId);
    response.once('finish', () => trace.finish(response, 'finish'));
    response.once('close', () => { if (active.has(response)) trace.finish(response, 'aborted'); });
  } catch { reportDrop('request setup failed'); }
  next();
};

export type DuplicationSpanName =
  | 'request.total' | 'auth.session' | 'duplicate.validate' | 'transaction.total' | 'transaction.entry'
  | 'tenant.bind' | 'source.lock_read' | 'copy.document_insert' | 'copy.lines_insert'
  | 'copy.document_read' | 'copy.pricing_inputs_read' | 'copy.pricing_calculate'
  | 'copy.amounts_write' | 'projection.lines_read' | 'projection.pricing_calculate'
  | 'projection.build' | 'transaction.exit' | 'response.encode_send';

export type DuplicationSpan = {
  name: DuplicationSpanName;
  parent: 'request.total' | 'transaction.total' | null;
  startMs: number;
  durationMs: number;
  outcome: 'ok' | 'error';
};

export type DuplicationTraceRecord = {
  requestId: string;
  runId?: string;
  variant?: string;
  route: 'POST /documents/:id/duplicate';
  status: number;
  outcome: 'finish' | 'aborted';
  totalMs: number;
  sourceState?: 'draft' | 'finalized';
  lineCountBucket?: '0' | '1-9' | '10-99' | '100-499' | '500+';
  copiedRows?: number;
  queryCount: number;
  responseBytes?: number;
  spans: DuplicationSpan[];
};

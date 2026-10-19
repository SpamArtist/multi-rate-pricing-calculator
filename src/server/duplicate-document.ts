import { withTenantTransaction } from '../db/client.js';
import {
  insertDuplicateDocument, insertDuplicateLines, lockDuplicationSource, readDuplicateDocument,
} from '../db/document-duplication-persistence.js';
import { writeDraftAmounts } from '../db/draft-amount-persistence.js';
import { databaseLineInput, projectDocument, readDocumentLines } from '../db/document-projection.js';
import { calculatePricing } from '../shared/pricing.js';
import type { AuthenticatedOwnerId } from '../shared/types/authenticated-owner.js';
import { measureDuplication, measureDuplicationSync, type DuplicationTrace } from './duplication-trace.js';

export async function duplicateDocument(
  ownerId: AuthenticatedOwnerId, sourceId: string, issueDate: string, trace?: DuplicationTrace,
) {
  let callbackEnd = 0;
  let bindStart = 0;
  const transactionStart = trace ? performance.now() : 0;
  try {
    const duplicate = await measureDuplication(trace, 'transaction.total', () => withTenantTransaction(ownerId, async transaction => {
      const source = await measureDuplication(trace, 'source.lock_read',
        () => lockDuplicationSource(transaction, sourceId), true);
      if (!source) return undefined;
      if (trace) trace.sourceState = source.status === 'finalized' ? 'finalized' : 'draft';

      const copyId = await measureDuplication(trace, 'copy.document_insert',
        () => insertDuplicateDocument(transaction, ownerId, source, issueDate), true);
      const copiedRows = await measureDuplication(trace, 'copy.lines_insert',
        () => insertDuplicateLines(transaction, source.id, copyId), true);
      if (trace && copiedRows !== null) {
        trace.copiedRows = copiedRows;
        trace.setLineCount(copiedRows);
      }
      const copy = await measureDuplication(trace, 'copy.document_read',
        () => readDuplicateDocument(transaction, copyId), true);
      const lines = await measureDuplication(trace, 'projection.lines_read',
        () => readDocumentLines(transaction, copyId), true);
      const pricing = measureDuplicationSync(trace, 'copy.pricing_calculate', () => {
        const calculated = calculatePricing(lines.map(databaseLineInput));
        if (!calculated.withinSafeRange) throw new RangeError('Copied draft amounts exceed the safe integer range.');
        return calculated;
      });
      await measureDuplication(trace, 'copy.amounts_write',
        () => writeDraftAmounts(transaction, copyId, pricing.amounts), true);
      return measureDuplicationSync(trace, 'projection.build', () => projectDocument(copy, lines, pricing));
    }, { observer: trace ? {
      onEntry: () => trace.add('transaction.entry', transactionStart),
      onBindStart: () => { bindStart = performance.now(); trace.queryCount += 1; },
      onBindEnd: error => trace.add('tenant.bind', bindStart, error ? 'error' : 'ok'),
      onCallbackEnd: () => { callbackEnd = performance.now(); },
    } : undefined }));
    if (trace && callbackEnd) trace.add('transaction.exit', callbackEnd);
    return duplicate;
  } catch (error) {
    if (trace && callbackEnd) trace.add('transaction.exit', callbackEnd, 'error');
    throw error;
  }
}

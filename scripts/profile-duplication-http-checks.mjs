import assert from 'node:assert/strict';

const issueDate = '2026-10-19';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const amountKeys = ['subtotalCents', 'discountCents', 'taxableCents', 'taxCents', 'totalCents'];
const documentKeys = ['id', 'title', 'customerName', 'issueDate', 'status', 'createdAt', 'updatedAt', 'finalizedAt', 'lineItems', 'amounts'];
const lineKeys = ['id', 'position', 'description', 'quantity', 'unitPriceCents', 'discountCents', 'taxRateBasisPoints', 'amounts'];

function expectedAmounts(line) {
  for (const key of ['quantity', 'unitPriceCents', 'discountCents', 'taxRateBasisPoints']) {
    assert.ok(Number.isSafeInteger(line[key]) && line[key] >= 0, `Invalid fixture ${key}`);
  }
  const subtotal = BigInt(line.quantity) * BigInt(line.unitPriceCents);
  const discount = BigInt(line.discountCents);
  assert.ok(discount <= subtotal, 'Fixture discount exceeds subtotal');
  const taxable = subtotal - discount;
  // Independent fixture oracle: round each line's tax to the nearest cent, ties up.
  // Finalized snapshots are deliberately not used as expected copied-draft amounts.
  const tax = (taxable * BigInt(line.taxRateBasisPoints) + 5000n) / 10000n;
  const values = [subtotal, discount, taxable, tax, taxable + tax];
  assert.ok(values.every(value => value <= BigInt(Number.MAX_SAFE_INTEGER)), 'Fixture amounts exceed safe range');
  return Object.fromEntries(amountKeys.map((key, index) => [key, Number(values[index])]));
}

export function verifyHttpCopy(copy, source) {
  assert.deepEqual(Object.keys(copy).sort(), [...documentKeys].sort());
  assert.match(copy.id, uuid);
  assert.notEqual(copy.id, source.id);
  assert.equal(copy.title, source.title.trim());
  assert.equal(copy.customerName, source.customerName.trim());
  assert.equal(copy.issueDate, issueDate);
  assert.equal(copy.status, 'draft');
  assert.equal(copy.finalizedAt, null);
  for (const key of ['createdAt', 'updatedAt']) {
    assert.equal(typeof copy[key], 'string');
    assert.ok(Number.isFinite(Date.parse(copy[key])), `Invalid copy ${key}`);
  }
  assert.equal(copy.createdAt, copy.updatedAt);
  assert.equal(copy.lineItems.length, source.lineItems.length);
  const ordered = [...source.lineItems].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
  const sourceIds = new Set(ordered.map(line => line.id));
  const copyIds = new Set();
  const totals = Object.fromEntries(amountKeys.map(key => [key, 0n]));
  for (const [index, line] of copy.lineItems.entries()) {
    const original = ordered[index];
    assert.deepEqual(Object.keys(line).sort(), [...lineKeys].sort());
    assert.match(line.id, uuid);
    assert.ok(!sourceIds.has(line.id), 'Copy reused a source line ID');
    assert.ok(!copyIds.has(line.id), 'Copy returned duplicate line IDs');
    copyIds.add(line.id);
    assert.equal(line.position, index + 1);
    for (const key of ['description', 'quantity', 'unitPriceCents', 'discountCents', 'taxRateBasisPoints']) {
      assert.equal(line[key], original[key]);
    }
    const amounts = expectedAmounts(original);
    assert.deepEqual(line.amounts, amounts);
    for (const key of amountKeys) totals[key] += BigInt(amounts[key]);
  }
  assert.ok(Object.values(totals).every(value => value <= BigInt(Number.MAX_SAFE_INTEGER)));
  assert.deepEqual(copy.amounts, Object.fromEntries(amountKeys.map(key => [key, Number(totals[key])])));
}

export async function verifyHttpIsolation({ request, ownerCookie, foreignCookie, source, foreignSource, admin }) {
  assert.ok(ownerCookie && foreignCookie && ownerCookie !== foreignCookie, 'Expected two explicit authenticated cookies');
  assert.notEqual(source.id, foreignSource.id);
  const results = [];
  const created = new Set();
  const body = { issueDate };
  const sourceIds = [source.id, foreignSource.id];
  const copyPath = `/documents/${source.id}/duplicate`;
  const counts = async () => (await admin.query(`SELECT (SELECT count(*) FROM documents)::int AS documents,
    (SELECT count(*) FROM line_items)::int AS lines`)).rows[0];
  const snapshot = async () => ({
    documents: (await admin.query('SELECT * FROM documents WHERE id = ANY($1::uuid[]) ORDER BY id', [sourceIds])).rows,
    lines: (await admin.query('SELECT * FROM line_items WHERE document_id = ANY($1::uuid[]) ORDER BY document_id, position, id', [sourceIds])).rows,
  });
  const beforeCounts = await counts();
  const beforeSnapshot = await snapshot();
  assert.equal(beforeSnapshot.documents.length, 2);
  async function expect(path, method, payload, cookie, status) {
    const response = await request(path, method, payload, cookie);
    assert.equal(response.status, status, `Unexpected status for ${method} ${path}`);
    return response.data;
  }
  try {
    await expect(copyPath, 'POST', body, '', 401);
    results.push({ check: 'http-unauthenticated-copy-denied', passed: true });
    const foreign = await expect(copyPath, 'POST', body, foreignCookie, 404);
    const missing = await expect('/documents/00000000-0000-4000-8000-000000000000/duplicate', 'POST', body, foreignCookie, 404);
    assert.deepEqual(foreign, missing);
    await expect(copyPath, 'POST', { issueDate: '2026-02-30' }, ownerCookie, 422);
    assert.deepEqual(await counts(), beforeCounts);
    results.push({ check: 'http-foreign-missing-invalid-copy-no-writes', passed: true });

    assert.deepEqual(await expect(`/documents/${source.id}`, 'GET', undefined, ownerCookie, 200), source);
    await expect(`/documents/${source.id}`, 'GET', undefined, foreignCookie, 404);
    assert.deepEqual(await expect(`/documents/${foreignSource.id}`, 'GET', undefined, foreignCookie, 200), foreignSource);
    await expect(`/documents/${foreignSource.id}`, 'GET', undefined, ownerCookie, 404);
    assert.deepEqual(await expect(`/documents/${source.id}`, 'GET', undefined, ownerCookie, 200), source);
    results.push({ check: 'http-owner-a-b-a-visibility', passed: true });

    // Both requests settle before checking either response, so successful siblings
    // remain available for cleanup even when another request fails.
    const concurrent = await Promise.allSettled([
      request(copyPath, 'POST', body, ownerCookie),
      request(copyPath, 'POST', body, ownerCookie),
    ]);
    for (const outcome of concurrent) {
      const response = outcome.status === 'fulfilled' ? outcome.value : undefined;
      if (response?.status === 201 && typeof response.data?.id === 'string'
        && uuid.test(response.data.id) && !sourceIds.includes(response.data.id)) created.add(response.data.id);
    }
    const copies = concurrent.map(outcome => {
      assert.equal(outcome.status, 'fulfilled', 'Concurrent HTTP duplication failed');
      assert.equal(outcome.value.status, 201);
      verifyHttpCopy(outcome.value.data, source);
      return outcome.value.data;
    });
    assert.notEqual(copies[0].id, copies[1].id);
    const firstIds = new Set(copies[0].lineItems.map(line => line.id));
    assert.ok(copies[1].lineItems.every(line => !firstIds.has(line.id)));
    for (const copy of copies) {
      assert.deepEqual(await expect(`/documents/${copy.id}`, 'GET', undefined, ownerCookie, 200), copy);
      await expect(`/documents/${copy.id}`, 'GET', undefined, foreignCookie, 404);
    }
    results.push({ check: 'http-concurrent-copies-distinct-complete-private', passed: true });
    assert.deepEqual(await expect(`/documents/${source.id}`, 'GET', undefined, ownerCookie, 200), source);
    assert.deepEqual(await expect(`/documents/${foreignSource.id}`, 'GET', undefined, foreignCookie, 200), foreignSource);
    assert.deepEqual(await snapshot(), beforeSnapshot);
    results.push({ check: 'http-and-database-sources-unchanged', passed: true });
  } finally {
    const cleanup = await Promise.allSettled([...created].map(async id => {
      await expect(`/documents/${id}`, 'DELETE', undefined, ownerCookie, 204);
      await expect(`/documents/${id}`, 'GET', undefined, ownerCookie, 404);
    }));
    for (const outcome of cleanup) assert.equal(outcome.status, 'fulfilled', 'HTTP check copy cleanup failed; use runner owner ledger');
  }
  assert.deepEqual(await counts(), beforeCounts);
  results.push({ check: 'http-check-copies-cleaned', passed: true });
  return results;
}

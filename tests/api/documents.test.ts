import { createServer } from 'node:http';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeDatabase } from '../../src/db/client.js';
import { createApp } from '../../src/server/app.js';
import { createApiSession } from '../support/api-session.js';
import { deleteTestOwner, migrationPool, withOwner } from '../support/db-fixture.js';
import { TestClock } from '../support/test-clock.js';
import type { DocumentListResponse } from '../../src/shared/types/document-list.js';

const clock = new TestClock('2026-10-14T08:00:00.000Z');
const server = createServer(createApp(undefined, clock, { signupRateLimit: { maxRequests: 100 } }));
const createdOwnerIds: string[] = [];
let baseUrl = '';

async function listen(): Promise<string> {
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP server address');
  return `http://127.0.0.1:${address.port}`;
}

async function close(): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

async function signedInClient(email: string): Promise<{ client: ReturnType<typeof createApiSession>; ownerId: string }> {
  const client = createApiSession();
  const response = await client.fetch(`${baseUrl}/auth/sign-up`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'A🔐b$cD' }),
  });
  expect(response.status).toBe(201);
  const result = await response.json() as { user: { id: string } };
  createdOwnerIds.push(result.user.id);
  return { client, ownerId: result.user.id };
}

function jsonRequest(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: {
      origin: baseUrl,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

async function countedLineFetches(url: string, client: ReturnType<typeof createApiSession>): Promise<number> {
  const querySpy = vi.spyOn(Client.prototype, 'query');
  try {
    const response = await client.fetch(url);
    expect(response.status).toBe(200);
    await response.json();
    return querySpy.mock.calls.filter(([statement]) => {
      const query: unknown = statement;
      const text = typeof query === 'string' ? query
        : query && typeof query === 'object' && 'text' in query && typeof query.text === 'string' ? query.text : '';
      return /^select\b/i.test(text.trim()) && /\bfrom\s+"?line_items"?\b/i.test(text);
    }).length;
  } finally {
    querySpy.mockRestore();
  }
}

async function countedDocumentListFetch(
  url: string, client: ReturnType<typeof createApiSession>,
): Promise<{ body: DocumentListResponse; countQueries: number }> {
  const querySpy = vi.spyOn(Client.prototype, 'query');
  try {
    const response = await client.fetch(url);
    expect(response.status).toBe(200);
    const body = await response.json() as DocumentListResponse;
    const countQueries = querySpy.mock.calls.filter(([statement]) => {
      const query: unknown = statement;
      const text = typeof query === 'string' ? query
        : query && typeof query === 'object' && 'text' in query && typeof query.text === 'string' ? query.text : '';
      return /\bcount\s*\(\s*\*\s*\)/i.test(text) && /\bfrom\s+"?documents"?\b/i.test(text);
    }).length;
    return { body, countQueries };
  } finally {
    querySpy.mockRestore();
  }
}

async function createDraft(
  client: ReturnType<typeof createApiSession>,
  input: { title: string; customerName?: string; issueDate: string },
): Promise<{ id: string }> {
  const response = await client.fetch(`${baseUrl}/documents`, jsonRequest('POST', input));
  expect(response.status).toBe(201);
  return await response.json() as { id: string };
}

async function addLine(
  client: ReturnType<typeof createApiSession>,
  documentId: string,
  input: { description: string; quantity: number; unitPriceCents: number; discountCents?: number; taxRateBasisPoints?: number },
): Promise<void> {
  const response = await client.fetch(`${baseUrl}/documents/${documentId}/line-items`, jsonRequest('POST', input));
  expect(response.status).toBe(201);
}

async function finalizeDocument(client: ReturnType<typeof createApiSession>, documentId: string): Promise<void> {
  const response = await client.fetch(`${baseUrl}/documents/${documentId}/finalize`, jsonRequest('POST', {}));
  expect(response.status).toBe(200);
}

describe('document drafts', () => {
  beforeAll(async () => { baseUrl = await listen(); });

  afterAll(async () => {
    await close();
    for (const ownerId of createdOwnerIds) await deleteTestOwner(ownerId);
    await Promise.all([migrationPool.end(), closeDatabase()]);
  });

  it.each(['/documents', '/documents/draft-save'])('authenticates before parsing JSON at %s', async path => {
    const request = {
      method: 'POST',
      headers: { origin: baseUrl, 'content-type': 'application/json' },
      body: '{',
    };
    const unauthenticated = await fetch(`${baseUrl}${path}`, request);
    expect(unauthenticated.status).toBe(401);
    expect(await unauthenticated.json()).toEqual({
      error: { code: 'unauthenticated', message: 'Sign in to continue.' },
    });

    const { client } = await signedInClient(`parse-order-${path.replaceAll('/', '-')}@example.com`);
    const authenticated = await client.fetch(`${baseUrl}${path}`, request);
    expect(authenticated.status).toBe(422);
    expect(await authenticated.json()).toMatchObject({ error: { code: 'validation_failed' } });
  });

  it('requires title and real issue date, rejects client-controlled fields, and saves an empty draft', async () => {
    const { client } = await signedInClient('documents-create@example.com');

    const empty = await client.fetch(`${baseUrl}/documents`, jsonRequest('POST', {}));
    expect(empty.status).toBe(422);
    expect((await empty.json() as { error: { fields: Record<string, string> } }).error.fields)
      .toMatchObject({ title: expect.any(String), issueDate: expect.any(String) });

    for (const { body, field } of [
      { body: { title: '   ', issueDate: '2026-10-14' }, field: 'title' },
      { body: { title: 'Draft', issueDate: '2026-02-30' }, field: 'issueDate' },
      { body: { title: 'Draft', issueDate: null }, field: 'issueDate' },
      { body: { title: 'Draft', issueDate: '2026-2-03' }, field: 'issueDate' },
      { body: { title: 'Draft', issueDate: '2026-10-14', ownerId: 'client-owned' }, field: 'ownerId' },
      { body: { title: 'Draft', issueDate: '2026-10-14', status: 'finalized' }, field: 'status' },
      { body: { title: 'Draft', issueDate: '2026-10-14', amounts: {} }, field: 'amounts' },
      { body: { title: 'Draft', issueDate: '2026-10-14', lineItems: [] }, field: 'lineItems' },
    ]) {
      const response = await client.fetch(`${baseUrl}/documents`, jsonRequest('POST', body));
      expect(response.status).toBe(422);
      expect((await response.json() as { error: { fields: Record<string, string> } }).error.fields).toHaveProperty(field);
    }

    const response = await client.fetch(`${baseUrl}/documents`, jsonRequest('POST', {
      title: '  Brand workshop  ',
      issueDate: '2026-10-14',
    }));
    expect(response.status).toBe(201);
    const document = await response.json() as {
      id: string;
      title: string;
      customerName: string;
      issueDate: string;
      status: string;
      lineItems: unknown[];
      amounts: Record<string, number>;
      ownerId?: string;
    };
    expect(document.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(document).toMatchObject({
      title: 'Brand workshop',
      customerName: '',
      issueDate: '2026-10-14',
      status: 'draft',
      lineItems: [],
      amounts: {
        subtotalCents: 0,
        discountCents: 0,
        taxableCents: 0,
        taxCents: 0,
        totalCents: 0,
      },
    });
    expect(document).not.toHaveProperty('ownerId');
    expect(document).not.toHaveProperty('passwordHash');
    expect(document).not.toHaveProperty('sessionToken');

    const detail = await client.fetch(`${baseUrl}/documents/${document.id}`);
    expect(detail.status).toBe(200);
    expect(await detail.json()).toEqual(document);

    const list = await client.fetch(`${baseUrl}/documents`);
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({
      items: [expect.objectContaining({ id: document.id, title: 'Brand workshop', issueDate: '2026-10-14' })],
      page: 1,
      pageSize: 25,
      totalItems: 1,
      totalPages: 1,
    });
  });

  it('rejects control characters in document text and search', async () => {
    const { client } = await signedInClient('documents-control-characters@example.com');
    for (const { body, field } of [
      { body: { title: 'a\u0000b', issueDate: '2026-10-14' }, field: 'title' },
      { body: { title: 'Draft', customerName: 'a\u0001b', issueDate: '2026-10-14' }, field: 'customerName' },
    ]) {
      const response = await client.fetch(`${baseUrl}/documents`, jsonRequest('POST', body));
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ error: { code: 'validation_failed', fields: { [field]: expect.any(String) } } });
    }

    const document = await createDraft(client, { title: 'Valid', issueDate: '2026-10-14' });
    const line = await client.fetch(`${baseUrl}/documents/${document.id}/line-items`, jsonRequest('POST', {
      description: 'a\u0000b', quantity: 1, unitPriceCents: 100,
    }));
    expect(line.status).toBe(422);
    expect(await line.json()).toMatchObject({ error: { code: 'validation_failed', fields: { description: expect.any(String) } } });

    const search = await client.fetch(`${baseUrl}/documents?search=%00`);
    expect(search.status).toBe(422);
    expect(await search.json()).toMatchObject({ error: { code: 'validation_failed', fields: { search: expect.any(String) } } });
  });

  it('searches customers, combines status and inclusive date filters, and returns current amounts', async () => {
    const { client } = await signedInClient('documents-list-filters@example.com');
    const draft = await createDraft(client, { title: 'Current draft', customerName: 'Acme Studio', issueDate: '2026-10-14' });
    await addLine(client, draft.id, { description: 'Design work', quantity: 2, unitPriceCents: 2500, discountCents: 500, taxRateBasisPoints: 1000 });
    const finalized = await createDraft(client, { title: 'Fixed snapshot', customerName: 'North ACME', issueDate: '2026-10-15' });
    await addLine(client, finalized.id, { description: 'Build', quantity: 2, unitPriceCents: 999, discountCents: 100, taxRateBasisPoints: 1000 });
    await finalizeDocument(client, finalized.id);
    await createDraft(client, { title: 'Older Acme', customerName: 'Acme Archive', issueDate: '2026-10-01' });
    await createDraft(client, { title: 'Other customer', customerName: 'Beta Works', issueDate: '2026-10-15' });

    const defaultResponse = await client.fetch(`${baseUrl}/documents`);
    expect(defaultResponse.status).toBe(200);
    const defaults = await defaultResponse.json() as { items: Array<{ title: string; issueDate: string }>; page: number; pageSize: number; totalItems: number; totalPages: number };
    expect(defaults).toMatchObject({ page: 1, pageSize: 25, totalItems: 4, totalPages: 1 });
    expect(defaults.items.map(item => item.issueDate)).toEqual(['2026-10-15', '2026-10-15', '2026-10-14', '2026-10-01']);
    expect(defaults.items.slice(0, 2).map(item => item.title).sort()).toEqual(['Fixed snapshot', 'Other customer']);

    const allStatusResponse = await client.fetch(`${baseUrl}/documents?status=all`);
    expect(allStatusResponse.status).toBe(200);
    expect((await allStatusResponse.json() as { totalItems: number }).totalItems).toBe(4);
    const draftsResponse = await client.fetch(`${baseUrl}/documents?status=draft`);
    expect(draftsResponse.status).toBe(200);
    expect((await draftsResponse.json() as { items: Array<{ title: string }> }).items.map(item => item.title).sort())
      .toEqual(['Current draft', 'Older Acme', 'Other customer']);

    const search = await client.fetch(`${baseUrl}/documents?search=${encodeURIComponent('  acME  ')}`);
    expect(search.status).toBe(200);
    const searched = await search.json() as { items: Array<{ title: string; amounts: { totalCents: number }; lineItems?: unknown }> };
    expect(searched.items.map(item => item.title)).toEqual(['Fixed snapshot', 'Current draft', 'Older Acme']);
    expect(searched.items[0]).toMatchObject({ title: 'Fixed snapshot', amounts: { totalCents: 2088 } });
    expect(searched.items[1]).toMatchObject({
      title: 'Current draft',
      amounts: { subtotalCents: 5000, discountCents: 500, taxableCents: 4500, taxCents: 450, totalCents: 4950 },
    });
    expect(searched.items.every(item => !Object.hasOwn(item, 'lineItems'))).toBe(true);

    const startOnly = await client.fetch(`${baseUrl}/documents?issueDateStart=2026-10-15`);
    expect(startOnly.status).toBe(200);
    const fromDate = await startOnly.json() as { items: Array<{ title: string }> };
    expect(fromDate.items.map(item => item.title).sort()).toEqual(['Fixed snapshot', 'Other customer']);
    const endOnly = await client.fetch(`${baseUrl}/documents?issueDateEnd=2026-10-14`);
    expect(endOnly.status).toBe(200);
    expect((await endOnly.json() as { items: Array<{ title: string }> }).items.map(item => item.title))
      .toEqual(['Current draft', 'Older Acme']);

    const combined = await client.fetch(`${baseUrl}/documents?search=acme&status=finalized&issueDateStart=2026-10-14&issueDateEnd=2026-10-15`);
    expect(combined.status).toBe(200);
    const filtered = await combined.json() as { items: Array<{ id: string; amounts: { subtotalCents: number; discountCents: number; taxableCents: number; taxCents: number; totalCents: number } }>; totalItems: number };
    expect(filtered.totalItems).toBe(1);
    expect(filtered.items).toEqual([expect.objectContaining({
      id: finalized.id,
      amounts: { subtotalCents: 1998, discountCents: 100, taxableCents: 1898, taxCents: 190, totalCents: 2088 },
    })]);
  });

  it('sorts issue dates in either direction with ascending ID ties', async () => {
    const { client } = await signedInClient('documents-list-sort@example.com');
    await createDraft(client, { title: 'Tie first', issueDate: '2026-10-14' });
    await createDraft(client, { title: 'Later date', issueDate: '2026-10-15' });
    await createDraft(client, { title: 'Tie second', issueDate: '2026-10-14' });
    await createDraft(client, { title: 'Earlier date', issueDate: '2026-10-13' });

    for (const sort of ['desc', 'asc']) {
      const response = await client.fetch(`${baseUrl}/documents?sort=${sort}`);
      expect(response.status).toBe(200);
      const result = await response.json() as { items: Array<{ id: string; issueDate: string }> };
      const dates = result.items.map(item => item.issueDate);
      expect(dates).toEqual(sort === 'desc' ? [...dates].sort().reverse() : [...dates].sort());
      const tiedIds = result.items.filter(item => item.issueDate === '2026-10-14').map(item => item.id);
      expect(tiedIds).toEqual([...tiedIds].sort());
    }
  });

  it('paginates 26 matches and keeps accurate metadata beyond the last page', async () => {
    const { client } = await signedInClient('documents-list-pages@example.com');
    for (let day = 1; day <= 26; day += 1) {
      await createDraft(client, {
        title: `Acme ${day}`,
        customerName: 'Acme Studio',
        issueDate: `2026-08-${String(day).padStart(2, '0')}`,
      });
    }

    const firstResponse = await client.fetch(`${baseUrl}/documents?search=acme`);
    expect(firstResponse.status).toBe(200);
    const first = await firstResponse.json() as { items: Array<{ id: string }>; page: number; pageSize: number; totalItems: number; totalPages: number };
    expect(first).toMatchObject({ page: 1, pageSize: 25, totalItems: 26, totalPages: 2 });
    expect(first.items).toHaveLength(25);

    const secondResponse = await client.fetch(`${baseUrl}/documents?search=acme&page=2`);
    const second = await secondResponse.json() as { items: Array<{ id: string }>; page: number; pageSize: number; totalItems: number; totalPages: number };
    expect(second).toMatchObject({ page: 2, pageSize: 25, totalItems: 26, totalPages: 2 });
    expect(second.items).toHaveLength(1);

    const beyondResponse = await client.fetch(`${baseUrl}/documents?search=acme&page=3`);
    const beyond = await beyondResponse.json() as { items: unknown[]; page: number; pageSize: number; totalItems: number; totalPages: number };
    expect(beyond).toEqual({ items: [], page: 3, pageSize: 25, totalItems: 26, totalPages: 2, firstCursor: null, lastCursor: null });

    expect(await countedLineFetches(`${baseUrl}/documents?search=acme`, client)).toBe(1);
    expect(await countedLineFetches(`${baseUrl}/documents?search=acme&page=2`, client)).toBe(1);
    expect(await countedLineFetches(`${baseUrl}/documents?search=acme&page=3`, client)).toBe(0);
  });

  it('seeks across pages and reopens visited pages with stable date and UUID ordering', async () => {
    const { client } = await signedInClient('documents-list-cursors@example.com');
    for (let day = 1; day <= 51; day += 1) {
      await createDraft(client, {
        title: `Cursor ${day}`,
        customerName: 'Cursor Customer',
        issueDate: day <= 27 ? '2026-08-01' : '2026-08-02',
      });
    }

    const getPage = async (sort: 'asc' | 'desc', page: number, cursor?: string): Promise<DocumentListResponse> => {
      const params = new URLSearchParams({ search: 'Cursor Customer', sort, page: String(page) });
      if (cursor) params.set('cursor', cursor);
      const response = await client.fetch(`${baseUrl}/documents?${params}`);
      expect(response.status).toBe(200);
      return response.json() as Promise<DocumentListResponse>;
    };

    for (const sort of ['asc', 'desc'] as const) {
      const first = await getPage(sort, 1);
      const second = await getPage(sort, 2);
      const third = await getPage(sort, 3);
      expect([first.items.length, second.items.length, third.items.length]).toEqual([25, 25, 1]);
      expect(first.totalItems).toBe(51);
      expect(first.totalPages).toBe(3);
      const ids = [first, second, third].flatMap(page => page.items.map(item => item.id));
      expect(new Set(ids).size).toBe(51);
      expect((await getPage(sort, 2, `after:${first.lastCursor}`)).items.map(item => item.id))
        .toEqual(second.items.map(item => item.id));
      expect((await getPage(sort, 1, `before:${second.firstCursor}`)).items.map(item => item.id))
        .toEqual(first.items.map(item => item.id));
      expect((await getPage(sort, 3, `after:${second.lastCursor}`)).items.map(item => item.id))
        .toEqual(third.items.map(item => item.id));
      expect((await getPage(sort, 3, `at:${third.firstCursor}`)).items.map(item => item.id))
        .toEqual(third.items.map(item => item.id));
    }

    const initial = await countedDocumentListFetch(`${baseUrl}/documents?search=Cursor`, client);
    expect(initial.countQueries).toBe(1);
    expect(initial.body.totalItems).toBe(51);
    const direct = await countedDocumentListFetch(`${baseUrl}/documents?search=Cursor&page=2`, client);
    expect(direct.countQueries).toBe(1);
    const cursor = encodeURIComponent(`after:${initial.body.lastCursor}`);
    const skipped = await countedDocumentListFetch(`${baseUrl}/documents?search=Cursor&page=2&cursor=${cursor}&includeTotal=false`, client);
    expect(skipped.countQueries).toBe(0);
    expect(skipped.body).not.toHaveProperty('totalItems');
    expect(skipped.body).not.toHaveProperty('totalPages');
    expect(skipped.body.items.map(item => item.id)).toEqual(direct.body.items.map(item => item.id));
    for (const [page, seek, expectedIds] of [
      [1, 'before:' + direct.body.firstCursor, initial.body.items.map(item => item.id)],
      [2, 'at:' + direct.body.firstCursor, direct.body.items.map(item => item.id)],
    ] as const) {
      const url = baseUrl + '/documents?search=Cursor&page=' + page
        + '&cursor=' + encodeURIComponent(seek) + '&includeTotal=false';
      const result = await countedDocumentListFetch(url, client);
      expect(result.countQueries).toBe(0);
      expect(result.body).not.toHaveProperty('totalItems');
      expect(result.body).not.toHaveProperty('totalPages');
      expect(result.body.items.map(item => item.id)).toEqual(expectedIds);
    }
    const countedCursor = await countedDocumentListFetch(`${baseUrl}/documents?search=Cursor&page=2&cursor=${cursor}`, client);
    expect(countedCursor.countQueries).toBe(1);
    expect(countedCursor.body.totalItems).toBe(51);
    const filtered = await countedDocumentListFetch(`${baseUrl}/documents?status=draft`, client);
    expect(filtered.countQueries).toBe(1);
  });

  it('lists finalized pages from snapshots without fetching line items', async () => {
    const { client, ownerId } = await signedInClient('documents-list-finalized-query-count@example.com');
    for (const title of ['First snapshot', 'Second snapshot']) {
      const document = await createDraft(client, { title, customerName: 'Acme', issueDate: '2026-10-14' });
      await addLine(client, document.id, { description: title, quantity: 1, unitPriceCents: 100 });
      await finalizeDocument(client, document.id);
    }
    await withOwner(ownerId, connection => connection.query('UPDATE line_items SET tax_rate_basis_points = 10000 WHERE description = $1', ['First snapshot']));
    expect(await countedLineFetches(`${baseUrl}/documents?status=finalized`, client)).toBe(0);
    const response = await client.fetch(`${baseUrl}/documents?status=finalized`);
    const list = await response.json() as { items: Array<{ amounts: { totalCents: number } }> };
    expect(list.items.map(item => item.amounts.totalCents)).toEqual([100, 100]);
  });

  it('rejects unknown, repeated, malformed, and reversed list query values', async () => {
    const { client } = await signedInClient('documents-list-invalid@example.com');
    for (const { query, field } of [
      { query: '?extra=1', field: 'extra' },
      { query: '?search=Acme&search=Beta', field: 'search' },
      { query: '?status=complete', field: 'status' },
      { query: '?issueDateStart=2026-02-30', field: 'issueDateStart' },
      { query: '?issueDateEnd=', field: 'issueDateEnd' },
      { query: '?issueDateStart=2026-10-15&issueDateEnd=2026-10-14', field: 'issueDateEnd' },
      { query: '?sort=newest', field: 'sort' },
      { query: '?page=0', field: 'page' },
      { query: '?page=1.5', field: 'page' },
      { query: '?page=9007199254740992', field: 'page' },
      { query: '?cursor=after:2026-08-01:00000000-0000-0000-0000-000000000000', field: 'page' },
      { query: '?page=2&cursor=bad', field: 'cursor' },
      { query: '?includeTotal=false', field: 'includeTotal' },
      { query: '?includeTotal=maybe', field: 'includeTotal' },
      { query: '?page=2&cursor=bad&includeTotal=false', field: 'includeTotal' },
    ]) {
      const response = await client.fetch(`${baseUrl}/documents${query}`);
      expect(response.status).toBe(422);
      expect((await response.json() as { error: { fields: Record<string, string> } }).error.fields)
        .toHaveProperty(field);
    }
  });

  it('patches only supplied metadata, trims text, and preserves omission', async () => {
    const { client } = await signedInClient('documents-patch@example.com');
    const created = await client.fetch(`${baseUrl}/documents`, jsonRequest('POST', {
      title: 'Quarterly review', issueDate: '2026-10-14', customerName: 'First customer',
    }));
    const original = await created.json() as { id: string; title: string; issueDate: string; customerName: string };

    const changedCustomer = await client.fetch(`${baseUrl}/documents/${original.id}`, jsonRequest('PATCH', {
      customerName: '  Alpen Studio  ',
    }));
    expect(changedCustomer.status).toBe(200);
    expect(await changedCustomer.json()).toMatchObject({
      title: 'Quarterly review', issueDate: '2026-10-14', customerName: 'Alpen Studio',
    });

    const changedTitleAndDate = await client.fetch(`${baseUrl}/documents/${original.id}`, jsonRequest('PATCH', {
      title: '  Revised review ', issueDate: '2026-11-02',
    }));
    expect(changedTitleAndDate.status).toBe(200);
    expect(await changedTitleAndDate.json()).toMatchObject({
      title: 'Revised review', issueDate: '2026-11-02', customerName: 'Alpen Studio',
    });

    for (const { body, field } of [
      { body: {}, field: 'body' },
      { body: { title: '   ' }, field: 'title' },
      { body: { title: null }, field: 'title' },
      { body: { issueDate: null }, field: 'issueDate' },
      { body: { issueDate: '2026-02-30' }, field: 'issueDate' },
      { body: { customerName: null }, field: 'customerName' },
      { body: { ownerId: 'another-owner' }, field: 'ownerId' },
      { body: { status: 'finalized' }, field: 'status' },
      { body: { amounts: {} }, field: 'amounts' },
    ]) {
      const response = await client.fetch(`${baseUrl}/documents/${original.id}`, jsonRequest('PATCH', body));
      expect(response.status).toBe(422);
      expect((await response.json() as { error: { fields: Record<string, string> } }).error.fields).toHaveProperty(field);
    }

    const unchanged = await client.fetch(`${baseUrl}/documents/${original.id}`);
    expect(await unchanged.json()).toMatchObject({
      title: 'Revised review', issueDate: '2026-11-02', customerName: 'Alpen Studio',
    });
  });

  it('returns ordered line inputs and exact derived amounts without exposing ownership', async () => {
    const { client, ownerId } = await signedInClient('documents-order@example.com');
    const created = await client.fetch(`${baseUrl}/documents`, jsonRequest('POST', {
      title: 'Brand workshop', issueDate: '2026-10-14',
    }));
    const document = await created.json() as { id: string };

    await withOwner(ownerId, client => client.query(
      `INSERT INTO line_items (document_id, position, description, quantity, unit_price_cents, discount_cents, tax_rate_basis_points)
       VALUES ($1, 2, 'Print-ready files', 2, 250, 0, 750),
              ($1, 1, 'Brand workshop', 3, 1999, 1000, 1900)`,
      [document.id],
    ));

    const response = await client.fetch(`${baseUrl}/documents/${document.id}`);
    expect(response.status).toBe(200);
    const result = await response.json() as {
      lineItems: Array<{ position: number; description: string; amounts: Record<string, number> }>;
      amounts: Record<string, number>;
      ownerId?: string;
    };
    expect(result.lineItems.map(line => [line.position, line.description])).toEqual([
      [1, 'Brand workshop'],
      [2, 'Print-ready files'],
    ]);
    expect(result.lineItems.map(line => line.amounts)).toEqual([
      { subtotalCents: 5997, discountCents: 1000, taxableCents: 4997, taxCents: 949, totalCents: 5946 },
      { subtotalCents: 500, discountCents: 0, taxableCents: 500, taxCents: 38, totalCents: 538 },
    ]);
    expect(result.amounts).toEqual({
      subtotalCents: 6497, discountCents: 1000, taxableCents: 5497, taxCents: 987, totalCents: 6484,
    });
    expect(result).not.toHaveProperty('ownerId');
  });

  it('prices public HTTP line inserts with per-line half-up tax and server totals', async () => {
    const { client } = await signedInClient('documents-line-pricing@example.com');
    const created = await client.fetch(`${baseUrl}/documents`, jsonRequest('POST', {
      title: 'Brand workshop', issueDate: '2026-10-14',
    }));
    const document = await created.json() as { id: string };

    const workshop = await client.fetch(`${baseUrl}/documents/${document.id}/line-items`, jsonRequest('POST', {
      description: ' Brand workshop ', quantity: 3, unitPriceCents: 1999, discountCents: 1000, taxRateBasisPoints: 1900,
    }));
    expect(workshop.status).toBe(201);
    expect(await workshop.json()).toMatchObject({
      position: 1,
      description: 'Brand workshop',
      quantity: 3,
      unitPriceCents: 1999,
      discountCents: 1000,
      taxRateBasisPoints: 1900,
      amounts: { subtotalCents: 5997, discountCents: 1000, taxableCents: 4997, taxCents: 949, totalCents: 5946 },
    });

    const files = await client.fetch(`${baseUrl}/documents/${document.id}/line-items`, jsonRequest('POST', {
      description: 'Print-ready files', quantity: 2, unitPriceCents: 250, taxRateBasisPoints: 750,
    }));
    expect(files.status).toBe(201);
    expect(await files.json()).toMatchObject({
      position: 2,
      discountCents: 0,
      amounts: { subtotalCents: 500, discountCents: 0, taxableCents: 500, taxCents: 38, totalCents: 538 },
    });

    const detail = await client.fetch(`${baseUrl}/documents/${document.id}`);
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({
      lineItems: [
        { position: 1, description: 'Brand workshop', amounts: { totalCents: 5946 } },
        { position: 2, description: 'Print-ready files', amounts: { totalCents: 538 } },
      ],
      amounts: { subtotalCents: 6497, discountCents: 1000, taxableCents: 5497, taxCents: 987, totalCents: 6484 },
    });

    const ties = await client.fetch(`${baseUrl}/documents`, jsonRequest('POST', {
      title: 'Tax ties', issueDate: '2026-10-14',
    }));
    const tieDocument = await ties.json() as { id: string };
    for (let position = 1; position <= 2; position += 1) {
      const tie = await client.fetch(`${baseUrl}/documents/${tieDocument.id}/line-items`, jsonRequest('POST', {
        quantity: 1, unitPriceCents: 1, taxRateBasisPoints: 5000,
      }));
      expect(tie.status).toBe(201);
      expect(await tie.json()).toMatchObject({
        position,
        description: '',
        discountCents: 0,
        amounts: { subtotalCents: 1, discountCents: 0, taxableCents: 1, taxCents: 1, totalCents: 2 },
      });
    }
    const tieDetail = await client.fetch(`${baseUrl}/documents/${tieDocument.id}`);
    expect(await tieDetail.json()).toMatchObject({ amounts: { taxCents: 2, totalCents: 4 } });

    const ordered = await client.fetch(`${baseUrl}/documents`, jsonRequest('POST', {
      title: 'Position ordering', issueDate: '2026-10-14',
    }));
    const orderedDocument = await ordered.json() as { id: string };
    for (const [description, position] of [['First', undefined], ['Inserted first', 1]] as const) {
      const inserted = await client.fetch(`${baseUrl}/documents/${orderedDocument.id}/line-items`, jsonRequest('POST', {
        description, quantity: 1, unitPriceCents: 100, ...(position === undefined ? {} : { position }),
      }));
      expect(inserted.status).toBe(201);
    }
    const orderedDetail = await client.fetch(`${baseUrl}/documents/${orderedDocument.id}`);
    const orderedResult = await orderedDetail.json() as { lineItems: Array<{ position: number; description: string }> };
    expect(orderedResult.lineItems.map(line => [line.position, line.description])).toEqual([
      [1, 'Inserted first'], [2, 'First'],
    ]);
  });

  it('rejects invalid, unsafe, and client-calculated line input without partial writes', async () => {
    const { client } = await signedInClient('documents-line-validation@example.com');
    const created = await client.fetch(`${baseUrl}/documents`, jsonRequest('POST', {
      title: 'Safe boundary', issueDate: '2026-10-14',
    }));
    const document = await created.json() as { id: string };
    const route = `${baseUrl}/documents/${document.id}/line-items`;

    for (const { body, field } of [
      { body: { unitPriceCents: 100 }, field: 'quantity' },
      { body: { quantity: 1 }, field: 'unitPriceCents' },
      { body: { quantity: 0, unitPriceCents: 100 }, field: 'quantity' },
      { body: { quantity: 1.5, unitPriceCents: 100 }, field: 'quantity' },
      { body: { quantity: null, unitPriceCents: 100 }, field: 'quantity' },
      { body: { quantity: 1, unitPriceCents: -1 }, field: 'unitPriceCents' },
      { body: { quantity: 1, unitPriceCents: null }, field: 'unitPriceCents' },
      { body: { quantity: 1, unitPriceCents: 100, discountCents: 101 }, field: 'discountCents' },
      { body: { quantity: 1, unitPriceCents: 100, taxRateBasisPoints: 10001 }, field: 'taxRateBasisPoints' },
      { body: { quantity: 1, unitPriceCents: 100, discountCents: null }, field: 'discountCents' },
      { body: { quantity: 1, unitPriceCents: 100, taxRateBasisPoints: null }, field: 'taxRateBasisPoints' },
      { body: { quantity: 1, unitPriceCents: 100, description: null }, field: 'description' },
      { body: { quantity: 1, unitPriceCents: 100, position: null }, field: 'position' },
      { body: { quantity: 1, unitPriceCents: 100, amounts: {} }, field: 'amounts' },
      { body: { quantity: 1, unitPriceCents: 100, ownerId: 'client-owned' }, field: 'ownerId' },
      { body: { quantity: 1, unitPriceCents: 100, subtotalCents: 100 }, field: 'subtotalCents' },
      { body: { quantity: 1, unitPriceCents: Number.MAX_SAFE_INTEGER + 1 }, field: 'unitPriceCents' },
      { body: { quantity: Number.MAX_SAFE_INTEGER, unitPriceCents: 2 }, field: 'body' },
      { body: { quantity: 1, unitPriceCents: 100, position: 2 }, field: 'position' },
    ]) {
      const response = await client.fetch(route, jsonRequest('POST', body));
      expect(response.status).toBe(422);
      expect((await response.json() as { error: { fields: Record<string, string> } }).error.fields).toHaveProperty(field);
    }

    const boundary = await client.fetch(route, jsonRequest('POST', {
      description: 'Safe maximum', quantity: Number.MAX_SAFE_INTEGER, unitPriceCents: 1,
    }));
    expect(boundary.status).toBe(201);
    expect(await boundary.json()).toMatchObject({
      quantity: Number.MAX_SAFE_INTEGER,
      amounts: { subtotalCents: Number.MAX_SAFE_INTEGER, totalCents: Number.MAX_SAFE_INTEGER },
    });

    const unsafeAggregate = await client.fetch(route, jsonRequest('POST', { quantity: 1, unitPriceCents: 1 }));
    expect(unsafeAggregate.status).toBe(422);
    expect((await unsafeAggregate.json() as { error: { fields: Record<string, string> } }).error.fields).toHaveProperty('body');
    const detail = await client.fetch(`${baseUrl}/documents/${document.id}`);
    expect(await detail.json()).toMatchObject({
      lineItems: [expect.objectContaining({ description: 'Safe maximum' })],
      amounts: { subtotalCents: Number.MAX_SAFE_INTEGER, totalCents: Number.MAX_SAFE_INTEGER },
    });
    const summary = await client.fetch(`${baseUrl}/documents`);
    expect(await summary.json()).toMatchObject({
      items: [expect.objectContaining({ id: document.id, amounts: expect.objectContaining({ totalCents: Number.MAX_SAFE_INTEGER }) })],
    });
  });

  it('keeps documents private and makes foreign and missing IDs indistinguishable', async () => {
    const ownerA = await signedInClient('documents-owner-a@example.com');
    const ownerB = await signedInClient('documents-owner-b@example.com');
    const created = await ownerA.client.fetch(`${baseUrl}/documents`, jsonRequest('POST', {
      title: 'Private draft', issueDate: '2026-10-14',
    }));
    const document = await created.json() as { id: string };

    const foreignRead = await ownerB.client.fetch(`${baseUrl}/documents/${document.id}`);
    const missingRead = await ownerB.client.fetch(`${baseUrl}/documents/00000000-0000-4000-8000-000000000000`);
    expect(foreignRead.status).toBe(404);
    expect(missingRead.status).toBe(404);
    const missingPayload = await missingRead.json();
    expect(await foreignRead.json()).toEqual(missingPayload);

    const foreignWrite = await ownerB.client.fetch(`${baseUrl}/documents/${document.id}`, jsonRequest('PATCH', { title: 'Changed' }));
    expect(foreignWrite.status).toBe(404);
    expect(await foreignWrite.json()).toEqual(missingPayload);
    const foreignLineInsert = await ownerB.client.fetch(`${baseUrl}/documents/${document.id}/line-items`, jsonRequest('POST', {
      quantity: 1, unitPriceCents: 100,
    }));
    const missingLineInsert = await ownerB.client.fetch(`${baseUrl}/documents/00000000-0000-4000-8000-000000000000/line-items`, jsonRequest('POST', {
      quantity: 1, unitPriceCents: 100,
    }));
    expect(foreignLineInsert.status).toBe(404);
    expect(await foreignLineInsert.json()).toEqual(await missingLineInsert.json());

    const ownerList = await ownerB.client.fetch(`${baseUrl}/documents`);
    expect((await ownerList.json() as { items: unknown[] }).items).toEqual([]);

    const unauthenticatedRead = await fetch(`${baseUrl}/documents/${document.id}`);
    const unauthenticatedCreate = await fetch(`${baseUrl}/documents`, {
      method: 'POST', headers: { origin: baseUrl, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'No session', issueDate: '2026-10-14' }),
    });
    const unauthenticatedPatch = await fetch(`${baseUrl}/documents/${document.id}`, {
      method: 'PATCH', headers: { origin: baseUrl, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'No session' }),
    });
    const unauthenticatedLineInsert = await fetch(`${baseUrl}/documents/${document.id}/line-items`, {
      method: 'POST', headers: { origin: baseUrl, 'content-type': 'application/json' },
      body: JSON.stringify({ quantity: 1, unitPriceCents: 100 }),
    });
    expect(unauthenticatedRead.status).toBe(401);
    expect(unauthenticatedCreate.status).toBe(401);
    expect(unauthenticatedPatch.status).toBe(401);
    expect(unauthenticatedLineInsert.status).toBe(401);
  });
});

import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { migrationPool } from '../support/db-fixture.js';

test('a pending save keeps every editor mutation locked until its snapshot is acknowledged', async ({ page }) => {
  const email = `save-lock-${randomUUID()}@example.com`;
  let releaseSave: (() => void) | undefined;
  try {
    await page.goto('/');
    await page.getByRole('button', { name: 'Create account' }).click();
    await page.getByLabel('Email address').fill(email);
    await page.getByLabel('Password').fill('A🔐b$cD');
    await page.getByRole('button', { name: 'Create account' }).click();
    await page.getByRole('button', { name: 'New document' }).click();
    await page.getByLabel('Document name').fill('Snapshot title');
    await page.getByRole('button', { name: 'Add line item' }).click();
    await page.getByLabel('Line description').fill('Saved line');

    let requestStarted!: () => void;
    const started = new Promise<void>(resolve => { requestStarted = resolve; });
    const released = new Promise<void>(resolve => { releaseSave = resolve; });
    await page.route('**/documents/draft-save', async route => {
      requestStarted();
      await released;
      await route.continue();
    });
    await page.getByRole('button', { name: 'Save as draft' }).click();
    await started;

    await expect(page.getByLabel('Document name')).toBeDisabled();
    await expect(page.getByLabel('Customer name')).toBeDisabled();
    await expect(page.getByLabel('Issue date')).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Add line item' })).toBeDisabled();
    await expect(page.getByLabel('Line description')).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Remove line 1' })).toBeDisabled();
    expect(await page.evaluate(() => Array.from({ length: sessionStorage.length }, (_, index) => sessionStorage.key(index))
      .filter(key => key?.endsWith(':pending-save')))).toHaveLength(1);
    releaseSave?.();
    await expect(page).toHaveURL(/#\/documents\/[0-9a-f-]+$/i);
    await expect(page.getByLabel('Document name')).toHaveValue('Snapshot title');
    await expect(page.getByTestId('line-item')).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Add line item' })).toBeEnabled();
    const documentId = new URL(page.url()).hash.split('/').at(-1)!;
    const detail = await (await page.context().request.get(new URL(`/documents/${documentId}`, page.url()).toString())).json() as {
      title: string; lineItems: Array<{ description: string }>;
    };
    expect(detail.title).toBe('Snapshot title');
    expect(detail.lineItems.map(line => line.description)).toEqual(['Saved line']);
    const keys = await page.evaluate(() => Array.from({ length: sessionStorage.length }, (_, index) => sessionStorage.key(index)));
    expect(keys.filter(key => key?.includes(':pending-save'))).toEqual([]);
  } finally {
    releaseSave?.();
    await migrationPool.query('DELETE FROM users WHERE email_canonical = $1', [email.toLowerCase()]);
  }
});

test('a committed creation followed by HTTP 502 replays the same mutation after reload', async ({ page }) => {
  const email = `save-502-${randomUUID()}@example.com`;
  try {
    await page.goto('/');
    await page.getByRole('button', { name: 'Create account' }).click();
    await page.getByLabel('Email address').fill(email);
    await page.getByLabel('Password').fill('A🔐b$cD');
    await page.getByRole('button', { name: 'Create account' }).click();
    await page.getByRole('button', { name: 'New document' }).click();
    await page.getByLabel('Document name').fill('Ambiguous gateway draft');

    const requests: Array<{ mutationId: string }> = [];
    let injected = false;
    await page.route('**/documents/draft-save', async route => {
      requests.push(route.request().postDataJSON() as { mutationId: string });
      if (injected) return route.continue();
      injected = true;
      const committed = await route.fetch();
      expect(committed.status()).toBe(201);
      await route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Gateway failed.' } }) });
    });

    await page.getByRole('button', { name: 'Save as draft' }).click();
    await expect(page.getByRole('alert')).toContainText('Gateway failed.');
    expect(await page.evaluate(() => Array.from({ length: sessionStorage.length }, (_, index) => sessionStorage.key(index))
      .filter(key => key?.endsWith(':pending-save')))).toHaveLength(1);
    await page.reload();
    await expect(page.getByLabel('Document name')).toHaveValue('Ambiguous gateway draft');
    await page.getByRole('button', { name: 'Save as draft' }).click();
    await expect(page).toHaveURL(/#\/documents\/[0-9a-f-]+$/i);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    expect(await page.evaluate(() => Array.from({ length: sessionStorage.length }, (_, index) => sessionStorage.key(index))
      .filter(key => key?.endsWith(':pending-save')))).toEqual([]);
    const list = await (await page.context().request.get(new URL('/documents', page.url()).toString())).json() as {
      items: Array<{ title: string }>;
    };
    expect(list.items.filter(item => item.title === 'Ambiguous gateway draft')).toHaveLength(1);
  } finally {
    await migrationPool.query('DELETE FROM users WHERE email_canonical = $1', [email.toLowerCase()]);
  }
});

test('retry after a committed draft request loses its response does not insert a line twice', async ({ page }) => {
  const email = `atomic-save-${randomUUID()}@example.com`;
  try {
    await page.goto('/');
    await page.getByRole('button', { name: 'Create account' }).click();
    await page.getByLabel('Email address').fill(email);
    await page.getByLabel('Password').fill('A🔐b$cD');
    await page.getByRole('button', { name: 'Create account' }).click();
    await page.getByRole('button', { name: 'New document' }).click();
    await page.getByLabel('Document name').fill('Atomic retry draft');
    for (const description of ['Alpha', 'Bravo']) {
      await page.getByRole('button', { name: 'Add line item' }).click();
      await page.getByTestId('line-item').last().getByLabel('Line description').fill(description);
    }
    await page.getByRole('button', { name: 'Save as draft' }).click();
    await expect(page).toHaveURL(/#\/documents\/[0-9a-f-]+$/i);
    const documentId = new URL(page.url()).hash.split('/').at(-1)!;
    const detailUrl = new URL(`/documents/${documentId}`, page.url()).toString();
    const before = await (await page.context().request.get(detailUrl)).json() as {
      lineItems: Array<{ id: string; description: string }>;
    };

    await page.getByRole('button', { name: 'Add line item' }).click();
    await page.getByTestId('line-item').last().getByLabel('Line description').fill('New retry line');
    await page.getByRole('button', { name: 'Move line 3 up' }).click();
    let aborted = false;
    const mutationRequests: string[] = [];
    page.on('request', request => {
      if (request.method() !== 'GET' && request.url().includes('/documents/')) mutationRequests.push(request.url());
    });
    await page.route('**/documents/draft-save', async route => {
      if (aborted) return route.continue();
      aborted = true;
      await route.fetch();
      await route.abort('failed');
    });
    await page.route(`**/documents/${documentId}/line-items/*`, async route => {
      if (aborted || route.request().method() !== 'PATCH') return route.continue();
      aborted = true;
      await route.abort('failed');
    });

    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByRole('alert')).toContainText('Connection failed');
    expect(aborted).toBe(true);
    const afterFailure = await (await page.context().request.get(detailUrl)).json() as {
      lineItems: Array<{ id: string; description: string }>;
    };
    expect(afterFailure.lineItems.map(line => line.description)).toEqual(['Alpha', 'New retry line', 'Bravo']);

    await page.reload();
    await expect(page.getByTestId('line-item')).toHaveCount(3);
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByRole('status')).toHaveText('Draft saved.');
    const afterRetry = await (await page.context().request.get(detailUrl)).json() as typeof afterFailure;
    expect(afterRetry.lineItems.map(line => line.description)).toEqual(['Alpha', 'New retry line', 'Bravo']);
    expect(afterRetry.lineItems.map(line => line.id)).toEqual(afterFailure.lineItems.map(line => line.id));
    expect(afterRetry.lineItems[0].id).toBe(before.lineItems[0].id);
    expect(afterRetry.lineItems[2].id).toBe(before.lineItems[1].id);
    expect(mutationRequests.filter(url => url.includes('/line-items'))).toEqual([]);
    expect(mutationRequests.filter(url => url.endsWith('/draft-save'))).toHaveLength(2);
  } finally {
    await migrationPool.query('DELETE FROM users WHERE email_canonical = $1', [email.toLowerCase()]);
  }
});

test('new draft replay finds committed document after reload and applies later edits', async ({ page }) => {
  const email = `atomic-create-${randomUUID()}@example.com`;
  try {
    await page.goto('/');
    await page.getByRole('button', { name: 'Create account' }).click();
    await page.getByLabel('Email address').fill(email);
    await page.getByLabel('Password').fill('A🔐b$cD');
    await page.getByRole('button', { name: 'Create account' }).click();
    await page.getByRole('button', { name: 'New document' }).click();
    await page.getByLabel('Document name').fill('Lost response draft');
    await page.getByRole('button', { name: 'Add line item' }).click();
    await page.getByTestId('line-item').getByLabel('Line description').fill('First line');

    let aborted = false;
    await page.route('**/documents/draft-save', async route => {
      if (aborted) return route.continue();
      aborted = true;
      await route.fetch();
      await route.abort('failed');
    });
    await page.getByRole('button', { name: 'Save as draft' }).click();
    await expect(page.getByRole('alert')).toContainText('Connection failed');
    expect(aborted).toBe(true);
    await page.reload();
    await expect(page.getByLabel('Document name')).toHaveValue('Lost response draft');
    await page.getByLabel('Customer name').fill('Edited after failure');
    await page.getByRole('button', { name: 'Save as draft' }).click();
    await expect(page).toHaveURL(/#\/documents\/[0-9a-f-]+$/i);
    await expect(page.getByRole('heading', { name: 'Lost response draft' })).toBeVisible();

    const listResponse = await page.context().request.get(new URL('/documents', page.url()).toString());
    const list = await listResponse.json() as { items: Array<{ id: string; title: string }> };
    const matches = list.items.filter(item => item.title === 'Lost response draft');
    expect(matches).toHaveLength(1);
    const detailResponse = await page.context().request.get(new URL(`/documents/${matches[0].id}`, page.url()).toString());
    const detail = await detailResponse.json() as {
      customerName: string; lineItems: Array<{ description: string }>;
    };
    expect(detail.customerName).toBe('Edited after failure');
    expect(detail.lineItems.map(line => line.description)).toEqual(['First line']);
  } finally {
    await migrationPool.query('DELETE FROM users WHERE email_canonical = $1', [email.toLowerCase()]);
  }
});

for (const failure of ['http', 'lost-response', 'auth-expired'] as const) {
  test(`new draft retains its identity when replay succeeds but the follow-up update fails (${failure})`, async ({ page }) => {
    const email = `replay-followup-${randomUUID()}@example.com`;
    try {
      await page.goto('/');
      await page.getByRole('button', { name: 'Create account' }).click();
      await page.getByLabel('Email address').fill(email);
      await page.getByLabel('Password').fill('A🔐b$cD');
      await page.getByRole('button', { name: 'Create account' }).click();
      await page.getByRole('button', { name: 'New document' }).click();
      await page.getByLabel('Document name').fill('Recovered draft');
      await page.getByRole('button', { name: 'Add line item' }).click();
      await page.getByLabel('Line description').fill('Original line');

      let requestCount = 0;
      let created: { id: string; lineItems: Array<{ id: string }> };
      await page.route('**/documents/draft-save', async route => {
        requestCount += 1;
        if (requestCount === 1) {
          const response = await route.fetch();
          created = await response.json();
          return route.abort('failed');
        }
        if (requestCount === 3) {
          if (failure === 'lost-response') {
            await route.fetch();
            return route.abort('failed');
          }
          return route.fulfill({
            status: failure === 'auth-expired' ? 401 : 500, contentType: 'application/json',
            body: JSON.stringify({ error: { message: 'Follow-up update failed.' } }),
          });
        }
        return route.continue();
      });

      await page.getByRole('button', { name: 'Save as draft' }).click();
      await expect(page.getByRole('alert')).toContainText('Connection failed');
      await page.reload();
      await page.getByLabel('Customer name').fill('Edit after lost response');
      await page.getByRole('button', { name: 'Save as draft' }).click();
      if (failure === 'auth-expired') {
        await expect(page.getByRole('heading', { name: 'Sign in to your workspace' })).toBeVisible();
        await page.getByLabel('Email address').fill(email);
        await page.getByLabel('Password').fill('A🔐b$cD');
        await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      }
      await expect(page.getByRole('button', { name: /^Save (as draft|changes)$/ })).toBeEnabled();
      expect(requestCount).toBe(3);

      // Reload must retain the recovered identity and current edits even after the second failure.
      await page.reload();
      await expect(page.getByLabel('Customer name')).toHaveValue('Edit after lost response');
      await page.getByRole('button', { name: /^Save (as draft|changes)$/ }).click();
      await expect(page).toHaveURL(new RegExp(`#/documents/${created!.id}$`));
      await expect(page.getByRole('button', { name: 'Save changes' })).toBeEnabled();
      const list = await (await page.context().request.get(new URL('/documents', page.url()).toString())).json() as {
        items: Array<{ id: string }>;
      };
      expect(list.items.map(document => document.id)).toEqual([created!.id]);
      const detail = await (await page.context().request.get(new URL(`/documents/${created!.id}`, page.url()).toString())).json() as {
        customerName: string; lineItems: Array<{ id: string; description: string }>;
      };
      expect(detail.customerName).toBe('Edit after lost response');
      expect(detail.lineItems).toMatchObject([{ id: created!.lineItems[0].id, description: 'Original line' }]);
    } finally {
      await migrationPool.query('DELETE FROM users WHERE email_canonical = $1', [email.toLowerCase()]);
    }
  });
}

test('lost finalization response keeps a new document at its created ID', async ({ page }) => {
  const email = `atomic-finalize-${randomUUID()}@example.com`;
  try {
    await page.goto('/');
    await page.getByRole('button', { name: 'Create account' }).click();
    await page.getByLabel('Email address').fill(email);
    await page.getByLabel('Password').fill('A🔐b$cD');
    await page.getByRole('button', { name: 'Create account' }).click();
    await page.getByRole('button', { name: 'New document' }).click();
    await page.getByLabel('Document name').fill('Finalize once');
    await page.getByLabel('Customer name').fill('Customer');
    await page.getByRole('button', { name: 'Add line item' }).click();
    await page.getByTestId('line-item').getByLabel('Line description').fill('Line');
    let aborted = false;
    await page.route('**/documents/*/finalize', async route => {
      if (aborted) return route.continue();
      aborted = true;
      await route.fetch();
      await route.abort('failed');
    });
    await page.getByRole('button', { name: 'Finalize document' }).click();
    await expect(page).toHaveURL(/#\/documents\/[0-9a-f-]+$/i);
    expect(aborted).toBe(true);
    await page.reload();
    await expect(page.getByText('Fixed snapshot', { exact: true })).toBeVisible();
    const listResponse = await page.context().request.get(new URL('/documents', page.url()).toString());
    const list = await listResponse.json() as { items: Array<{ title: string }> };
    expect(list.items.filter(item => item.title === 'Finalize once')).toHaveLength(1);
  } finally {
    await migrationPool.query('DELETE FROM users WHERE email_canonical = $1', [email.toLowerCase()]);
  }
});

test('finalized reload ignores stale local edits and prints the server snapshot', async ({ page }) => {
  const email = `finalized-recovery-${randomUUID()}@example.com`;
  try {
    await page.goto('/');
    await page.getByRole('button', { name: 'Create account' }).click();
    await page.getByLabel('Email address').fill(email);
    await page.getByLabel('Password').fill('A🔐b$cD');
    await page.getByRole('button', { name: 'Create account' }).click();
    await page.getByRole('button', { name: 'New document' }).click();
    await page.getByLabel('Document name').fill('Authoritative title');
    await page.getByLabel('Customer name').fill('Server customer');
    await page.getByLabel('Issue date').fill('2026-10-14');
    for (const [description, quantity, unitPrice, discount, taxRate] of [
      ['Alpha', '2', '10.00', '1.00', '10.00'],
      ['Bravo', '1', '5.00', '0.00', '0.00'],
    ]) {
      await page.getByRole('button', { name: 'Add line item' }).click();
      const line = page.getByTestId('line-item').last();
      await line.getByLabel('Line description').fill(description);
      await line.getByLabel('Qty').fill(quantity);
      await line.getByLabel('Unit price €').fill(unitPrice);
      await line.getByLabel('Discount €').fill(discount);
      await line.getByLabel('Tax %').fill(taxRate);
    }
    await page.getByRole('button', { name: 'Save as draft' }).click();
    await expect(page).toHaveURL(/#\/documents\/[0-9a-f-]+$/i);
    const documentId = new URL(page.url()).hash.split('/').at(-1)!;
    const detailUrl = new URL(`/documents/${documentId}`, page.url()).toString();

    await page.getByLabel('Document name').fill('Unsaved local title');
    await page.getByLabel('Customer name').fill('Local customer');
    await page.getByLabel('Issue date').fill('2026-10-20');
    await page.getByTestId('line-item').first().getByLabel('Qty').fill('9');
    await page.getByRole('button', { name: 'Remove line 2' }).click();
    const otherDocumentId = randomUUID();
    const recoveryKeys = await page.evaluate(({ documentId, otherDocumentId }) => {
      const keys = Array.from({ length: sessionStorage.length }, (_, index) => sessionStorage.key(index));
      const lineKey = keys.find(key => key?.endsWith(`:${documentId}:lines`));
      if (!lineKey) throw new Error('Expected local line recovery key');
      const documentPrefix = lineKey.slice(0, -':lines'.length);
      const ownerPrefix = documentPrefix.slice(0, -documentId.length);
      sessionStorage.setItem(`${documentPrefix}:errors`, JSON.stringify({
        document: { title: 'Stale error' }, lines: {}, submitted: true,
      }));
      sessionStorage.setItem(`${documentPrefix}:pending-save`, JSON.stringify({
        body: { mutationId: crypto.randomUUID(), documentId, title: 'Stale mutation',
          customerName: 'Local customer', issueDate: '2026-10-20', lineItems: [] },
        lineKeys: [], signature: 'stale',
      }));
      const otherPendingKey = `${ownerPrefix}${otherDocumentId}:pending-save`;
      sessionStorage.setItem(otherPendingKey, 'other document recovery');
      return { documentPrefix, otherPendingKey };
    }, { documentId, otherDocumentId });

    const finalizedResponse = await page.context().request.post(`${detailUrl}/finalize`, {
      headers: { origin: new URL(page.url()).origin }, data: {},
    });
    expect(finalizedResponse.status()).toBe(200);
    const snapshot = await finalizedResponse.json() as {
      status: string; title: string; customerName: string; issueDate: string;
      lineItems: Array<{ id: string; position: number; description: string; quantity: number;
        unitPriceCents: number; discountCents: number; taxRateBasisPoints: number;
        amounts: { totalCents: number } }>;
      amounts: { totalCents: number };
    };
    expect(snapshot).toMatchObject({
      status: 'finalized', title: 'Authoritative title', customerName: 'Server customer',
      issueDate: '2026-10-14',
      lineItems: [
        { position: 1, description: 'Alpha', quantity: 2, unitPriceCents: 1000,
          discountCents: 100, taxRateBasisPoints: 1000, amounts: { totalCents: 2090 } },
        { position: 2, description: 'Bravo', quantity: 1, unitPriceCents: 500,
          discountCents: 0, taxRateBasisPoints: 0, amounts: { totalCents: 500 } },
      ],
      amounts: { totalCents: 2590 },
    });

    await page.reload();
    await expect(page.getByText('Fixed snapshot', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Document name')).toHaveValue(snapshot.title);
    await expect(page.getByLabel('Customer name')).toHaveValue(snapshot.customerName);
    await expect(page.getByLabel('Issue date')).toHaveValue(snapshot.issueDate);
    await expect(page.getByTestId('line-item')).toHaveCount(snapshot.lineItems.length);
    for (const [index, line] of snapshot.lineItems.entries()) {
      const row = page.getByTestId('line-item').nth(index);
      await expect(row.getByLabel('Line description')).toHaveValue(line.description);
      await expect(row.getByLabel('Qty')).toHaveValue(String(line.quantity));
      await expect(row.getByLabel('Unit price €')).toHaveValue((line.unitPriceCents / 100).toFixed(2));
      await expect(row.getByLabel('Discount €')).toHaveValue((line.discountCents / 100).toFixed(2));
      await expect(row.getByLabel('Tax %')).toHaveValue((line.taxRateBasisPoints / 100).toFixed(2));
      await expect(row.locator('.line-sum')).toContainText(`€${(line.amounts.totalCents / 100).toFixed(2)}`);
      await expect(row.getByLabel('Line description')).toBeDisabled();
      await expect(row.getByRole('button')).toHaveCount(0);
    }
    await expect(page.locator('.grand-total')).toContainText('€25.90');
    await expect(page.getByRole('button', { name: 'Save changes' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Finalize document' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Add line item' })).toHaveCount(0);
    await expect(page.locator('.field-error')).toHaveCount(0);
    expect(await page.evaluate(({ documentPrefix, otherPendingKey }) => ({
      documentKeys: Array.from({ length: sessionStorage.length }, (_, index) => sessionStorage.key(index))
        .filter(key => key?.startsWith(documentPrefix)),
      otherPending: sessionStorage.getItem(otherPendingKey),
    }), recoveryKeys)).toEqual({ documentKeys: [], otherPending: 'other document recovery' });

    await page.emulateMedia({ media: 'print' });
    await expect(page.locator('.metadata-fields .print-value').first()).toBeVisible();
    await expect(page.locator('.line-description .print-value').first()).toBeVisible();
    await expect(page.locator('.metadata-fields .print-value')).toHaveText([
      snapshot.title, snapshot.customerName, '14 Oct 2026',
    ]);
    await expect(page.locator('.line-description .print-value')).toHaveText(['Alpha', 'Bravo']);
    await expect(page.locator('.grand-total')).toContainText('€25.90');
    await expect(page.locator('.status-badge')).toHaveText('Finalized');
  } finally {
    await migrationPool.query('DELETE FROM users WHERE email_canonical = $1', [email.toLowerCase()]);
  }
});

test('pre-save recovery preserves interleaved new lines and removed saved lines', async ({ page }) => {
  const email = `ordered-recovery-${randomUUID()}@example.com`;
  try {
    await page.goto('/');
    await page.getByRole('button', { name: 'Create account' }).click();
    await page.getByLabel('Email address').fill(email);
    await page.getByLabel('Password').fill('A🔐b$cD');
    await page.getByRole('button', { name: 'Create account' }).click();
    await page.getByRole('button', { name: 'New document' }).click();
    await page.getByLabel('Document name').fill('Ordered recovery');
    for (const description of ['Alpha', 'Bravo', 'Charlie']) {
      await page.getByRole('button', { name: 'Add line item' }).click();
      await page.getByTestId('line-item').last().getByLabel('Line description').fill(description);
    }
    await page.getByRole('button', { name: 'Save as draft' }).click();
    await expect(page).toHaveURL(/#\/documents\/[0-9a-f-]+$/i);
    const documentId = new URL(page.url()).hash.split('/').at(-1)!;
    const detailUrl = new URL(`/documents/${documentId}`, page.url()).toString();
    const initial = await (await page.context().request.get(detailUrl)).json() as {
      lineItems: Array<{ id: string; description: string; position: number }>;
    };
    const saveRequests: string[] = [];
    page.on('request', request => {
      if (request.url().endsWith('/documents/draft-save')) saveRequests.push(request.method());
    });

    await page.getByRole('button', { name: 'Add line item' }).click();
    const firstNew = page.getByTestId('line-item').last();
    await firstNew.getByLabel('Line description').fill('New one');
    await firstNew.getByLabel('Qty').fill('2');
    await firstNew.getByLabel('Unit price €').fill('4.56');
    await page.getByRole('button', { name: 'Move line 4 up' }).click();
    await page.getByRole('button', { name: 'Move line 3 up' }).click();
    await page.getByRole('button', { name: 'Add line item' }).click();
    const secondNew = page.getByTestId('line-item').last();
    await secondNew.getByLabel('Line description').fill('New two');
    await secondNew.getByLabel('Qty').fill('3');
    await secondNew.getByLabel('Unit price €').fill('7.89');
    await page.getByRole('button', { name: 'Move line 5 up' }).click();
    await page.getByRole('button', { name: 'Remove line 5' }).click();
    expect(saveRequests).toEqual([]);

    await page.reload();
    await expect(page.getByTestId('line-item')).toHaveCount(4);
    expect(await page.getByLabel('Line description').evaluateAll(inputs =>
      inputs.map(input => (input as HTMLInputElement).value))).toEqual(['Alpha', 'New one', 'Bravo', 'New two']);
    await expect(page.getByTestId('line-item').nth(1).getByLabel('Qty')).toHaveValue('2');
    await expect(page.getByTestId('line-item').nth(1).getByLabel('Unit price €')).toHaveValue('4.56');
    await expect(page.getByTestId('line-item').nth(3).getByLabel('Qty')).toHaveValue('3');
    await expect(page.getByTestId('line-item').nth(3).getByLabel('Unit price €')).toHaveValue('7.89');
    expect(saveRequests).toEqual([]);
    const beforeSave = await (await page.context().request.get(detailUrl)).json() as typeof initial;
    expect(beforeSave.lineItems).toEqual(initial.lineItems);

    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByRole('status')).toHaveText('Draft saved.');
    const persisted = await (await page.context().request.get(detailUrl)).json() as typeof initial;
    expect(persisted.lineItems.map(line => [line.position, line.description])).toEqual([
      [1, 'Alpha'], [2, 'New one'], [3, 'Bravo'], [4, 'New two'],
    ]);
    expect(persisted.lineItems[0].id).toBe(initial.lineItems[0].id);
    expect(persisted.lineItems[2].id).toBe(initial.lineItems[1].id);
    expect(persisted.lineItems.every(line => line.id !== initial.lineItems[2].id)).toBe(true);
    expect(new Set(persisted.lineItems.map(line => line.id)).size).toBe(4);
    expect(saveRequests).toEqual(['POST']);
  } finally {
    await migrationPool.query('DELETE FROM users WHERE email_canonical = $1', [email.toLowerCase()]);
  }
});

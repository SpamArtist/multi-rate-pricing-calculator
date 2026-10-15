import { randomUUID } from 'node:crypto';
import { expect, test as base } from '@playwright/test';
import { migrationPool } from '../support/db-fixture.js';
import type { DocumentData, DraftSaveBody } from '../../src/web/api/contracts.js';

const test = base.extend<{ editor: void }>({
  editor: [async ({ page }, use) => {
    const email = `save-recovery-${randomUUID()}@example.com`;
    try {
      await page.goto('/');
      await page.getByRole('button', { name: 'Create account' }).click();
      await page.getByLabel('Email address').fill(email);
      await page.getByLabel('Password').fill('A🔐b$cD');
      await page.getByRole('button', { name: 'Create account' }).click();
      await page.getByRole('button', { name: 'New document' }).click();
      await page.getByLabel('Document name').fill('Recovery test');
      await page.getByLabel('Customer name').fill('Customer');
      await page.getByRole('button', { name: 'Add line item' }).click();
      await page.getByLabel('Line description').fill('Original line');
      await use();
    } finally {
      await migrationPool.query('DELETE FROM users WHERE email_canonical = $1', [email]);
    }
  }, { auto: true }],
});

test('existing draft reconciles a committed finalization whose response was lost', async ({ page }) => {
  await page.getByRole('button', { name: 'Save as draft' }).click();
  await expect(page).toHaveURL(/#\/documents\/[0-9a-f-]+$/i);
  await page.route('**/documents/*/finalize', async route => {
    expect((await route.fetch()).status()).toBe(200);
    await route.abort('failed');
  });
  await page.getByRole('button', { name: 'Finalize document' }).click();
  await expect(page.getByText('Fixed snapshot', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Document name')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Save changes' })).toHaveCount(0);
});

test('a finalization committed after reconciliation is recovered on the next save', async ({ page }) => {
  await page.getByRole('button', { name: 'Save as draft' }).click();
  await expect(page).toHaveURL(/#\/documents\/[0-9a-f-]+$/i);
  const documentId = new URL(page.url()).hash.split('/').at(-1)!;
  const finalizeUrl = new URL(`/documents/${documentId}/finalize`, page.url()).toString();
  await page.route('**/documents/*/finalize', route => route.abort('failed'));
  await page.getByRole('button', { name: 'Finalize document' }).click();
  await expect(page.getByRole('alert')).toContainText('Your draft stays editable');

  // Model the original request (or another tab) committing after the reconciliation read.
  const finalized = await page.context().request.post(finalizeUrl, {
    headers: { origin: new URL(page.url()).origin }, data: {},
  });
  expect(finalized.status()).toBe(200);
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Fixed snapshot', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Document name')).toBeDisabled();
});

for (const committed of [true, false]) {
  test(`uncertain finalization blocks edits and reconciles before retry (committed=${committed})`, async ({ page }) => {
    await page.getByRole('button', { name: 'Save as draft' }).click();
    await expect(page).toHaveURL(/#\/documents\/[0-9a-f-]+$/i);
    const documentId = new URL(page.url()).hash.split('/').at(-1)!;
    let detailAvailable = false;
    const requests: string[] = [];
    page.on('request', request => {
      if (request.url().includes('/documents/')) requests.push(`${request.method()} ${new URL(request.url()).pathname}`);
    });
    await page.route(`**/documents/${documentId}`, route => detailAvailable ? route.continue() : route.abort('failed'));
    await page.route(`**/documents/${documentId}/finalize`, async route => {
      if (committed) expect((await route.fetch()).status()).toBe(200);
      await route.abort('failed');
    });
    await page.getByRole('button', { name: 'Finalize document' }).click();
    await expect(page.getByRole('alert')).toContainText('Could not confirm finalization');
    await expect(page.getByLabel('Document name')).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Add line item' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Delete draft' })).toBeDisabled();
    requests.length = 0;
    detailAvailable = true;
    await page.getByRole('button', { name: 'Save changes' }).click();
    if (committed) {
      await expect(page.getByText('Fixed snapshot', { exact: true })).toBeVisible();
      expect(requests).toEqual([`GET /documents/${documentId}`]);
    } else {
      await expect(page.getByRole('status')).toHaveText('Draft saved.');
      await expect(page.getByLabel('Document name')).toBeEnabled();
      expect(requests[0]).toBe(`GET /documents/${documentId}`);
    }
  });
}

test('acknowledged new line IDs survive rejected finalization and a failed detail read', async ({ page }) => {
  await page.getByRole('button', { name: 'Save as draft' }).click();
  await expect(page).toHaveURL(/#\/documents\/[0-9a-f-]+$/i);
  const documentId = new URL(page.url()).hash.split('/').at(-1)!;
  const detailUrl = new URL(`/documents/${documentId}`, page.url()).toString();
  await page.getByRole('button', { name: 'Add line item' }).click();
  await page.getByLabel('Line description').last().fill('Acknowledged line');
  await page.getByLabel('Customer name').fill('');
  await page.route(`**/documents/${documentId}`, route => route.abort('failed'));
  await page.getByRole('button', { name: 'Finalize document' }).click();
  await expect(page.getByRole('button', { name: 'Save changes' })).toBeEnabled();
  const acknowledged = await (await page.context().request.get(detailUrl)).json() as DocumentData;
  expect(acknowledged.lineItems).toHaveLength(2);
  await page.getByLabel('Customer name').fill('Corrected customer');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('status')).toHaveText('Draft saved.');
  const retried = await (await page.context().request.get(detailUrl)).json() as DocumentData;
  expect(retried.lineItems.map(line => line.id)).toEqual(acknowledged.lineItems.map(line => line.id));
});

test('storage denial does not change the mutation ID when creation is retried', async ({ page }) => {
  await page.evaluate(() => {
    Storage.prototype.setItem = () => { throw new DOMException('Storage unavailable', 'QuotaExceededError'); };
  });
  const requests: DraftSaveBody[] = [];
  await page.route('**/documents/draft-save', async route => {
    requests.push(route.request().postDataJSON() as DraftSaveBody);
    if (requests.length > 1) return route.continue();
    expect((await route.fetch()).status()).toBe(201);
    await route.abort('failed');
  });
  await page.getByRole('button', { name: 'Save as draft' }).click();
  await expect(page.getByRole('alert')).toContainText('Connection failed');
  await page.getByLabel('Customer name').fill('Edited after failure');
  await page.getByRole('button', { name: 'Save as draft' }).click();
  await expect(page).toHaveURL(/#\/documents\/[0-9a-f-]+$/i);
  const list = await (await page.context().request.get(new URL('/documents', page.url()).toString())).json() as {
    items: Array<{ id: string; customerName: string }>;
  };
  expect(list.items).toHaveLength(1);
  expect(list.items[0].customerName).toBe('Edited after failure');
  expect(requests[1].mutationId).toBe(requests[0].mutationId);
  expect(requests[2].documentId).toBe(list.items[0].id);
});

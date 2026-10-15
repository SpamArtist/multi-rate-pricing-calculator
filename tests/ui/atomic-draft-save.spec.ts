import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { migrationPool } from '../support/db-fixture.js';

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

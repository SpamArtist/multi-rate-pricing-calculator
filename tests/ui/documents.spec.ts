import { createHash, randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { migrationPool } from '../support/db-fixture.js';

test.describe.configure({ mode: 'serial' });

test.afterAll(async () => { await migrationPool.end(); });

test('starts locally, saves a draft, reopens from Documents, and verifies persisted API values', async ({ page }) => {
  const email = `draft-${randomUUID()}@example.com`;
  const password = 'A🔐b$cD';
  try {
    await page.goto('/');
    await page.getByRole('button', { name: 'Create account' }).click();
    await page.getByLabel('Email address').fill(email);
    await page.getByLabel('Password').fill(password);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('heading', { name: 'Documents', exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'New document' }).click();
    await expect(page.getByRole('heading', { name: 'Untitled document' })).toBeVisible();
    const title = page.getByLabel('Document name');
    const customer = page.getByLabel('Customer name');
    const issueDate = page.getByLabel('Issue date');
    const expectedToday = await page.evaluate(() => {
      const date = new Date();
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    });
    await expect(issueDate).toHaveValue(expectedToday);
    await expect(page.getByRole('button', { name: 'Duplicate' })).toHaveCount(0);

    await customer.fill('Retained customer');
    await title.fill('');
    await issueDate.fill('');
    await page.getByRole('button', { name: 'Save as draft' }).click();
    await expect(page.getByText('Enter a document name.')).toBeVisible();
    await expect(page.getByText('Enter a valid issue date.')).toBeVisible();
    await expect(title).toHaveValue('');
    await expect(issueDate).toHaveValue('');
    await expect(customer).toHaveValue('Retained customer');

    await title.fill('Brand workshop');
    await issueDate.fill('2026-10-14');
    await page.getByRole('button', { name: 'Save as draft' }).click();
    await expect(page.getByRole('heading', { name: 'Brand workshop' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save changes' })).toBeVisible();

    await page.getByRole('button', { name: 'All documents' }).click();
    await expect(page.getByRole('link', { name: 'Brand workshop' })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Documents', exact: true })).toBeVisible();
    await page.getByRole('link', { name: 'Brand workshop' }).click();
    await expect(page.getByRole('heading', { name: 'Brand workshop' })).toBeVisible();
    await expect(customer).toHaveValue('Retained customer');

    await customer.fill('Alpen Studio');
    await issueDate.fill('2026-11-02');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByRole('status')).toHaveText('Draft saved.');
    await expect(page.getByRole('heading', { name: 'Brand workshop' })).toBeVisible();
    await page.screenshot().then(body => test.info().attach('issue-14-ledger-editor.png', { body, contentType: 'image/png' }));
    await page.setViewportSize({ width: 390, height: 844 });
    const mobileWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(mobileWidth).toBeLessThanOrEqual(390);
    await page.screenshot().then(body => test.info().attach('issue-14-ledger-editor-mobile.png', { body, contentType: 'image/png' }));

    const documentsResponse = await page.context().request.get(new URL('/documents', page.url()).toString());
    expect(documentsResponse.status()).toBe(200);
    const list = await documentsResponse.json() as { items: Array<{ id: string; title: string }> };
    const saved = list.items.find(item => item.title === 'Brand workshop');
    expect(saved).toBeDefined();
    await expect(page.locator('body')).not.toContainText(saved!.id);
    const persistedResponse = await page.context().request.get(new URL(`/documents/${saved!.id}`, page.url()).toString());
    expect(persistedResponse.status()).toBe(200);
    const persisted = await persistedResponse.json() as {
      id: string;
      title: string;
      customerName: string;
      issueDate: string;
      lineItems: unknown[];
      amounts: { totalCents: number };
      ownerId?: string;
    };
    expect(persisted).toMatchObject({
      id: saved!.id,
      title: 'Brand workshop',
      customerName: 'Alpen Studio',
      issueDate: '2026-11-02',
      lineItems: [],
      amounts: { totalCents: 0 },
    });
    expect(persisted).not.toHaveProperty('ownerId');
    await test.info().attach('issue-14-persisted-document.json', {
      body: JSON.stringify(persisted, null, 2), contentType: 'application/json',
    });

    await page.getByRole('button', { name: 'All documents' }).click();
    await expect(page.getByRole('cell', { name: 'Alpen Studio' })).toBeVisible();
    await expect(page.getByRole('cell', { name: '2 Nov 2026' })).toBeVisible();
  } finally {
    await migrationPool.query('DELETE FROM users WHERE email_canonical = $1', [email.toLowerCase()]);
  }
});

test('restores unsaved editor input after session expiry and sign-in', async ({ page }) => {
  const email = `resume-${randomUUID()}@example.com`;
  const password = 'A🔐b$cD';
  try {
    await page.goto('/');
    await page.getByRole('button', { name: 'Create account' }).click();
    await page.getByLabel('Email address').fill(email);
    await page.getByLabel('Password').fill(password);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('heading', { name: 'Documents', exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'New document' }).click();
    await page.getByLabel('Document name').fill('Unsaved workshop');
    await page.getByLabel('Customer name').fill('Recovered studio');

    const cookie = (await page.context().cookies()).find(value => value.name === '__Host-session');
    expect(cookie).toBeDefined();
    const tokenHash = createHash('sha256').update(cookie!.value).digest('hex');
    await migrationPool.query(
      "UPDATE sessions SET expires_at = created_at + interval '1 millisecond' WHERE token_hash = $1",
      [tokenHash],
    );

    await page.reload();
    await expect(page.getByRole('heading', { name: 'Sign in to your workspace' })).toBeVisible();
    await page.getByLabel('Email address').fill(email);
    await page.getByLabel('Password').fill(password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('heading', { name: 'Unsaved workshop' })).toBeVisible();
    await expect(page.getByLabel('Customer name')).toHaveValue('Recovered studio');
    await expect(page.getByRole('button', { name: 'Save as draft' })).toBeVisible();
  } finally {
    await migrationPool.query('DELETE FROM users WHERE email_canonical = $1', [email.toLowerCase()]);
  }
});

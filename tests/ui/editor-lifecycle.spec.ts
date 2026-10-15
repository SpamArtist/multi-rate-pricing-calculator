import { randomUUID } from 'node:crypto';
import { expect, test as base, type Page } from '@playwright/test';
import { migrationPool } from '../support/db-fixture.js';
import type { DocumentData } from '../../src/web/api/contracts.js';

const test = base.extend<{ editor: void }>({
  editor: [async ({ page }, use) => {
    const email = `editor-lifecycle-${randomUUID()}@example.com`;
    try {
      await page.goto('/');
      await page.getByRole('button', { name: 'Create account' }).click();
      await page.getByLabel('Email address').fill(email);
      await page.getByLabel('Password').fill('A🔐b$cD');
      await page.getByRole('button', { name: 'Create account' }).click();
      await page.getByRole('button', { name: 'New document' }).click();
      await page.getByLabel('Document name').fill('Editor lifetime');
      await page.getByLabel('Customer name').fill('Customer');
      await page.getByRole('button', { name: 'Add line item' }).click();
      await page.getByLabel('Line description').fill('Original line');
      await use();
    } finally {
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      await migrationPool.query('DELETE FROM users WHERE email_canonical = $1', [email]);
    }
  }, { auto: true }],
});

async function deliverResponse(page: Page, release: () => void): Promise<void> {
  const response = page.waitForResponse('**/documents/draft-save');
  release();
  await (await response).finished();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

test('a departed editor cannot erase a reopened editor recovery', async ({ page }) => {
  await page.getByRole('button', { name: 'Save as draft' }).click();
  await expect(page.getByRole('status')).toHaveText('Draft saved.');
  const documentUrl = page.url();
  let release!: () => void;
  let committed!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  const saved = new Promise<void>(resolve => { committed = resolve; });
  await page.route('**/documents/draft-save', async route => {
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    committed();
    await released;
    await route.fulfill({ response });
  });
  try {
    await page.getByLabel('Document name').fill('Earlier saved title');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await saved;
    await page.getByRole('button', { name: 'All documents' }).click();
    await expect(page.getByRole('button', { name: 'New document' })).toBeVisible();
    await page.goto(documentUrl);
    await page.getByLabel('Document name').fill('Newer unsaved title');
    await deliverResponse(page, release);
    await page.reload();
    await expect(page.getByLabel('Document name')).toHaveValue('Newer unsaved title');
  } finally {
    release();
  }
});

test('a late draft acknowledgement cannot recreate recovery after logout', async ({ page }) => {
  await page.getByLabel('Qty', { exact: true }).fill('');
  let release!: () => void;
  let committed!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  const saved = new Promise<void>(resolve => { committed = resolve; });
  await page.route('**/documents/draft-save', async route => {
    const response = await route.fetch();
    expect(response.status()).toBe(201);
    committed();
    await released;
    await route.fulfill({ response });
  });
  try {
    await page.getByRole('button', { name: 'Finalize document' }).click();
    await saved;
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByRole('heading', { name: 'Sign in to your workspace' })).toBeVisible();
    const recoveryKeys = () => page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith('pricing-calculator:editor:')));
    expect(await recoveryKeys()).toEqual([]);
    await deliverResponse(page, release);
    expect(await recoveryKeys()).toEqual([]);
  } finally {
    release();
  }
});

test('a created document keeps its route and recovery while finalization is pending', async ({ page }) => {
  let release!: () => void;
  let started!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  const finalizing = new Promise<void>(resolve => { started = resolve; });
  let documentId = '';
  await page.route('**/documents/draft-save', async route => {
    const response = await route.fetch();
    documentId = (await response.json() as DocumentData).id;
    await route.fulfill({ response });
  });
  await page.route('**/documents/*/finalize', async route => {
    started();
    await released;
    await route.abort('failed');
  });
  try {
    await page.getByRole('button', { name: 'Finalize document' }).click();
    await finalizing;
    await expect(page).toHaveURL(new RegExp(`#/documents/${documentId}$`));
    await page.reload();
    await expect(page.getByLabel('Document name')).toHaveValue('Editor lifetime');
    await expect(page.getByLabel('Line description')).toHaveValue('Original line');
    await expect(page.getByRole('button', { name: 'Save changes' })).toBeEnabled();
  } finally {
    release();
  }
});

test('an abandoned reconciliation cannot mutate recovery or reject unhandled', async ({ page }) => {
  await page.getByRole('button', { name: 'Save as draft' }).click();
  await expect(page.getByRole('status')).toHaveText('Draft saved.');
  const documentUrl = page.url();
  const documentId = new URL(documentUrl).hash.split('/').at(-1)!;
  let release!: () => void;
  let started!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  const reconciling = new Promise<void>(resolve => { started = resolve; });
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.route('**/documents/*/finalize', route => route.abort('failed'));
  await page.route(`**/documents/${documentId}`, async route => {
    const response = await route.fetch();
    started();
    await released;
    await route.fulfill({ response });
  }, { times: 1 });
  try {
    await page.getByRole('button', { name: 'Finalize document' }).click();
    await reconciling;
    await page.getByRole('button', { name: 'All documents' }).click();
    await expect(page.getByRole('button', { name: 'New document' })).toBeVisible();
    await page.goto(documentUrl);
    await page.getByLabel('Document name').fill('Keep edits during old reconciliation');
    const readRecovery = () => page.evaluate(() => Object.fromEntries(Object.entries(sessionStorage)
      .filter(([key]) => key.startsWith('pricing-calculator:editor:'))));
    const recovery = await readRecovery();
    const laterRequests: string[] = [];
    page.on('request', request => laterRequests.push(request.url()));
    const response = page.waitForResponse(`**/documents/${documentId}`);
    release();
    await (await response).finished();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(await readRecovery()).toEqual(recovery);
    expect(pageErrors).toEqual([]);
    expect(laterRequests).toEqual([]);
    await page.reload();
    await expect(page.getByLabel('Document name')).toHaveValue('Keep edits during old reconciliation');
  } finally {
    release();
  }
});

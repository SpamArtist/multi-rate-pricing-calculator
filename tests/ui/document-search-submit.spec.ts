import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { migrationPool } from '../support/db-fixture.js';

test('submits customer search on button or Enter while other filters stay immediate', async ({ page }) => {
  const email = `search-submit-${randomUUID()}@example.com`;
  try {
    await page.goto('/');
    await page.getByRole('button', { name: 'Create account' }).click();
    await page.getByLabel('Email address').fill(email);
    await page.getByLabel('Password').fill('A🔐b$cD');
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('heading', { name: 'Documents', exact: true })).toBeVisible();
    const documentsUrl = new URL('/documents', page.url()).toString();
    const origin = new URL(page.url()).origin;
    for (const customerName of ['Acme Studio', 'Beta Studio']) {
      const response = await page.context().request.post(documentsUrl, {
        headers: { origin }, data: { title: customerName, customerName, issueDate: '2026-10-14' },
      });
      expect(response.status()).toBe(201);
    }
    await page.reload();
    await expect(page.getByText('2 shown')).toBeVisible();

    const listRequests: URL[] = [];
    page.on('request', request => {
      const url = new URL(request.url());
      if (url.pathname === '/documents' && request.method() === 'GET') listRequests.push(url);
    });
    const search = page.getByLabel('Search customers');
    await search.pressSequentially('Acme');
    expect(listRequests).toHaveLength(0);
    await expect(page.getByText('2 shown')).toBeVisible();
    const statusResponse = page.waitForResponse(response => new URL(response.url()).searchParams.get('status') === 'draft');
    await page.getByLabel('Status').selectOption('draft');
    expect((await statusResponse).status()).toBe(200);
    expect(listRequests).toHaveLength(1);
    expect(listRequests[0].searchParams.has('search')).toBe(false);
    await expect(search).toHaveValue('Acme');

    const searchResponse = page.waitForResponse(response => new URL(response.url()).searchParams.get('search') === 'Acme');
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    expect((await searchResponse).status()).toBe(200);
    await expect(page.getByText('1 shown')).toBeVisible();
    await search.fill('');
    expect(listRequests).toHaveLength(2);
    const clearedResponse = page.waitForResponse(response => {
      const url = new URL(response.url());
      return url.pathname === '/documents' && url.searchParams.get('status') === 'draft' && !url.searchParams.has('search');
    });
    await search.press('Enter');
    expect((await clearedResponse).status()).toBe(200);
    await expect(page.getByText('2 shown')).toBeVisible();

    await page.setViewportSize({ width: 390, height: 844 });
    const mobileSearchButton = page.getByRole('button', { name: 'Search', exact: true });
    await expect(mobileSearchButton).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await search.fill('Beta');
    const mobileResponse = page.waitForResponse(response => new URL(response.url()).searchParams.get('search') === 'Beta');
    await mobileSearchButton.click();
    expect((await mobileResponse).status()).toBe(200);
    await expect(page.getByText('1 shown')).toBeVisible();
  } finally {
    await migrationPool.query('DELETE FROM users WHERE email_canonical = $1', [email.toLowerCase()]);
  }
});

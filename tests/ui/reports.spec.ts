import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { Pool } from 'pg';

test('opens an on-demand local-month summary independent of Ledger filters', async ({ page }) => {
  const email = `summary-${randomUUID()}@example.com`;
  const password = 'A🔐b$cD';
  const reportRequests: URL[] = [];
  const cleanupPool = new Pool({
    connectionString: process.env.MIGRATOR_DATABASE_URL
      ?? 'postgres://pricing_migrator:pricing_migrator@127.0.0.1:5432/pricing',
  });
  try {
    await page.goto('/');
    await page.getByRole('button', { name: 'Create account' }).click();
    await page.getByLabel('Email address').fill(email);
    await page.getByLabel('Password').fill(password);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('heading', { name: 'Documents', exact: true })).toBeVisible();

    const localDates = await page.evaluate(() => {
      const now = new Date();
      const format = (date: Date): string => (
        `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
      );
      return {
        today: format(now),
        monthStart: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`,
        monthEnd: format(new Date(now.getFullYear(), now.getMonth() + 1, 0)),
      };
    });
    const documentsUrl = new URL('/documents', page.url()).toString();
    const origin = new URL(page.url()).origin;
    for (let day = 1; day <= 26; day += 1) {
      const issueDate = `${localDates.monthStart.slice(0, 8)}${String(day).padStart(2, '0')}`;
      const created = await page.context().request.post(documentsUrl, {
        headers: { origin },
        data: { title: `Acme customer ${String(day).padStart(2, '0')}`, customerName: 'Acme Studio', issueDate },
      });
      expect(created.status()).toBe(201);
    }

    const anchor = await page.context().request.post(documentsUrl, {
      headers: { origin },
      data: { title: 'Summary anchor', customerName: 'Acme summary', issueDate: localDates.today },
    });
    expect(anchor.status()).toBe(201);
    const anchorDocument = await anchor.json() as { id: string };
    const line = await page.context().request.post(`${documentsUrl}/${anchorDocument.id}/line-items`, {
      headers: { origin },
      data: { description: 'Reportable work', quantity: 2, unitPriceCents: 1000, discountCents: 100, taxRateBasisPoints: 1000 },
    });
    expect(line.status()).toBe(201);
    const finalized = await page.context().request.post(`${documentsUrl}/${anchorDocument.id}/finalize`, {
      headers: { origin },
      data: {},
    });
    expect(finalized.status()).toBe(200);

    page.on('request', request => {
      const url = new URL(request.url());
      if (url.pathname === '/reports/summary') reportRequests.push(url);
    });
    await page.reload();
    await expect(page.getByText('27 shown')).toBeVisible();
    expect(reportRequests).toHaveLength(0);

    const initialReportResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/reports/summary');
    await page.getByRole('button', { name: 'Generate Summary' }).click();
    const initialResponse = await initialReportResponse;
    expect(initialResponse.status()).toBe(200);
    const initialBody = await initialResponse.json() as {
      start: string;
      end: string;
      finalizedDocumentCount: number;
      amounts: Record<string, number>;
    };
    expect(new URL(initialResponse.url()).searchParams.get('start')).toBe(localDates.monthStart);
    expect(new URL(initialResponse.url()).searchParams.get('end')).toBe(localDates.monthEnd);
    expect(initialBody).toEqual({
      start: localDates.monthStart,
      end: localDates.monthEnd,
      finalizedDocumentCount: 1,
      amounts: { subtotalCents: 2000, discountCents: 100, taxableCents: 1900, taxCents: 190, totalCents: 2090 },
    });
    const sidebar = page.getByRole('complementary', { name: 'Summary report' });
    await expect(sidebar).toBeVisible();
    await expect(page.getByRole('button', { name: 'Generate Summary' })).toHaveAttribute('aria-expanded', 'true');
    await expect(sidebar).toContainText('€20.90');
    await expect(sidebar).toContainText('€20.00');
    await expect(sidebar).toContainText('−€1.00');
    await expect(sidebar).toContainText('€19.00');
    await expect(sidebar).toContainText('€1.90');
    await expect(sidebar).toContainText('1');
    await page.setViewportSize({ width: 1440, height: 1000 });
    await test.info().attach('issue-21-summary-sidebar-desktop.png', {
      body: await page.screenshot(), contentType: 'image/png',
    });
    await test.info().attach('issue-21-summary-initial-api.json', {
      body: JSON.stringify(initialBody, null, 2), contentType: 'application/json',
    });

    await page.getByRole('button', { name: 'Page 2' }).click();
    await expect(page.getByRole('button', { name: 'Page 2' })).toHaveAttribute('aria-current', 'page');
    const searchResponsePromise = page.waitForResponse(response => {
      const url = new URL(response.url());
      return url.pathname === '/documents' && url.searchParams.get('search') === 'Acme';
    });
    await page.getByLabel('Search customers').fill('Acme');
    expect((await searchResponsePromise).status()).toBe(200);
    await expect(page.getByRole('button', { name: 'Page 1' })).toHaveAttribute('aria-current', 'page');

    const statusResponsePromise = page.waitForResponse(response => {
      const url = new URL(response.url());
      return url.pathname === '/documents' && url.searchParams.get('status') === 'finalized';
    });
    await page.getByLabel('Status').selectOption('finalized');
    expect((await statusResponsePromise).status()).toBe(200);
    const sortResponsePromise = page.waitForResponse(response => {
      const url = new URL(response.url());
      return url.pathname === '/documents' && url.searchParams.get('sort') === 'asc';
    });
    await page.getByLabel('Sort by issue date').selectOption('asc');
    expect((await sortResponsePromise).status()).toBe(200);

    const fromResponsePromise = page.waitForResponse(response => {
      const url = new URL(response.url());
      return url.pathname === '/documents' && url.searchParams.get('issueDateStart') === localDates.today;
    });
    await page.getByLabel('From issue date').fill(localDates.today);
    expect((await fromResponsePromise).status()).toBe(200);
    const toResponsePromise = page.waitForResponse(response => {
      const url = new URL(response.url());
      return url.pathname === '/documents'
        && url.searchParams.get('issueDateStart') === localDates.today
        && url.searchParams.get('issueDateEnd') === localDates.today;
    });
    await page.getByLabel('To issue date').fill(localDates.today);
    expect((await toResponsePromise).status()).toBe(200);
    await expect(sidebar).toContainText('€20.90');
    expect(reportRequests).toHaveLength(1);

    await page.getByLabel('Summary start date').fill('2099-12-31');
    await expect(page.getByRole('alert')).toHaveText('End date must be on or after start date.');
    expect(reportRequests).toHaveLength(1);
    await expect(sidebar).toContainText('—');

    const repairedResponsePromise = page.waitForResponse(response => new URL(response.url()).pathname === '/reports/summary');
    await page.getByLabel('Summary start date').fill(localDates.monthStart);
    const repairedResponse = await repairedResponsePromise;
    expect(repairedResponse.status()).toBe(200);
    const repairedBody = await repairedResponse.json() as typeof initialBody;
    expect(repairedBody).toEqual(initialBody);
    expect(reportRequests).toHaveLength(2);
    await expect(sidebar).toContainText('€20.90');
    await test.info().attach('issue-21-summary-repaired-api.json', {
      body: JSON.stringify(repairedBody, null, 2), contentType: 'application/json',
    });

    await page.getByRole('button', { name: 'Close summary' }).click();
    await expect(page.getByRole('button', { name: 'Generate Summary' })).toHaveAttribute('aria-expanded', 'false');
    await expect(sidebar).toBeHidden();
    const reopenedResponsePromise = page.waitForResponse(response => new URL(response.url()).pathname === '/reports/summary');
    await page.getByRole('button', { name: 'Generate Summary' }).click();
    expect((await reopenedResponsePromise).status()).toBe(200);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  } finally {
    try {
      await cleanupPool.query('DELETE FROM users WHERE email_canonical = $1', [email.toLowerCase()]);
    } finally {
      await cleanupPool.end();
    }
  }
});

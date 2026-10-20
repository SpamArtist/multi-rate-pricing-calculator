import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { migrationPool } from '../support/db-fixture.js';

test('uses direct jumps once and cached cursors for visited numbered pages', async ({ page }) => {
  const email = `cursor-pages-${randomUUID()}@example.com`;
  const password = 'A🔐b$cD';
  try {
    await page.goto('/');
    await page.getByRole('button', { name: 'Create account' }).click();
    await page.getByLabel('Email address').fill(email);
    await page.getByLabel('Password').fill(password);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('heading', { name: 'Documents', exact: true })).toBeVisible();

    const documentsUrl = new URL('/documents', page.url()).toString();
    const origin = new URL(page.url()).origin;
    for (let number = 1; number <= 51; number += 1) {
      const response = await page.context().request.post(documentsUrl, {
        headers: { origin },
        data: { title: `Cursor document ${number}`, issueDate: '2026-10-14' },
      });
      expect(response.status()).toBe(201);
    }

    await page.reload();
    await expect(page.getByText('51 shown')).toBeVisible();
    const jump = async (targetPage: number): Promise<{ url: URL; id: string }> => {
      const responsePromise = page.waitForResponse(response => {
        const url = new URL(response.url());
        return url.pathname === '/documents' && url.searchParams.get('page') === String(targetPage);
      });
      await page.getByRole('button', { name: `Page ${targetPage}`, exact: true }).click();
      const response = await responsePromise;
      expect(response.status()).toBe(200);
      const result = await response.json() as { items: Array<{ id: string; title: string }>; totalItems?: number; totalPages?: number };
      if (new URL(response.url()).searchParams.has('cursor')) {
        expect(new URL(response.url()).searchParams.get('includeTotal')).toBe('false');
        expect(result).not.toHaveProperty('totalItems');
        expect(result).not.toHaveProperty('totalPages');
        await expect(page.getByText('51 shown')).toBeVisible();
      } else expect(result.totalItems).toBe(51);
      await expect(page.getByRole('link', { name: result.items[0].title, exact: true })).toBeVisible();
      return { url: new URL(response.url()), id: result.items[0].id };
    };

    const direct = await jump(3);
    expect(direct.url.searchParams.has('cursor')).toBe(false);
    const first = await jump(1);
    expect(first.url.searchParams.get('cursor')).toMatch(/^at:/);
    const revisit = await jump(3);
    expect(revisit.url.searchParams.get('cursor')).toMatch(/^at:/);
    expect(revisit.id).toBe(direct.id);

    await jump(1);
    const removed = await page.context().request.delete(`${documentsUrl}/${direct.id}`, { headers: { origin } });
    expect(removed.status()).toBe(204);
    const emptyCursor = page.waitForResponse(response => {
      const url = new URL(response.url());
      return url.pathname === '/documents' && url.searchParams.get('page') === '3' && url.searchParams.get('includeTotal') === 'false';
    });
    const countedRetry = page.waitForResponse(response => {
      const url = new URL(response.url());
      return url.pathname === '/documents' && url.searchParams.get('page') === '3' && !url.searchParams.has('cursor');
    });
    const finalPage = page.waitForResponse(response => {
      const url = new URL(response.url());
      return url.pathname === '/documents' && url.searchParams.get('page') === '2' && !url.searchParams.has('cursor');
    });
    await page.getByRole('button', { name: 'Page 3', exact: true }).click();
    expect((await (await emptyCursor).json() as { items: unknown[] }).items).toEqual([]);
    expect((await (await countedRetry).json() as { totalItems: number }).totalItems).toBe(50);
    expect((await finalPage).status()).toBe(200);
    await expect(page.getByRole('button', { name: 'Page 2', exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByText('50 shown')).toBeVisible();
  } finally {
    await migrationPool.query('DELETE FROM users WHERE email_canonical = $1', [email.toLowerCase()]);
  }
});

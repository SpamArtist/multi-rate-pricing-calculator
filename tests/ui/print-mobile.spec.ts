import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { Pool } from 'pg';

const cleanupPool = new Pool({
  connectionString: process.env.MIGRATOR_DATABASE_URL
    ?? 'postgres://pricing_migrator:pricing_migrator@127.0.0.1:5432/pricing',
});

test.describe.configure({ mode: 'serial' });

test.afterAll(async () => { await cleanupPool.end(); });

async function createAccount(page: Page, email: string): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password').fill('A🔐b$cD');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Documents', exact: true })).toBeVisible();
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const widths = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  expect(widths.document).toBeLessThanOrEqual(widths.viewport);
  expect(widths.body).toBeLessThanOrEqual(widths.viewport);
}

test('prints incomplete draft and frozen finalized detail without a print endpoint', async ({ page }) => {
  const email = `print-review-${randomUUID()}@example.com`;
  const requestPaths: string[] = [];
  page.on('request', request => requestPaths.push(new URL(request.url()).pathname));
  await page.addInitScript(() => {
    Object.defineProperty(window, 'print', {
      configurable: true,
      value: () => {
        const calls = Number(document.documentElement.dataset.printCalls ?? '0') + 1;
        document.documentElement.dataset.printCalls = String(calls);
      },
    });
  });

  try {
    await createAccount(page, email);
    await page.getByRole('button', { name: 'New document' }).click();
    await page.getByLabel('Document name').fill('Brand workshop');
    await page.getByLabel('Customer name').fill('Alpen Studio');
    await page.getByLabel('Issue date').fill('2026-10-14');

    await page.getByRole('button', { name: 'Add line item' }).click();
    const firstLine = page.getByTestId('line-item').nth(0);
    await firstLine.getByLabel('Qty').fill('3');
    await firstLine.getByLabel('Unit price €').fill('19.99');
    await firstLine.getByLabel('Discount €').fill('10.00');
    await firstLine.getByLabel('Tax %').fill('19.00');

    await page.getByRole('button', { name: 'Add line item' }).click();
    const secondLine = page.getByTestId('line-item').nth(1);
    await secondLine.getByLabel('Line description').fill('Print-ready files');
    await secondLine.getByLabel('Qty').fill('2');
    await secondLine.getByLabel('Unit price €').fill('2.50');
    await secondLine.getByLabel('Tax %').fill('7.50');
    await page.getByRole('button', { name: 'Save as draft' }).click();
    await expect(page).toHaveURL(/#\/documents\/[0-9a-f-]+$/i);
    const documentId = new URL(page.url()).hash.split('/').at(-1)!;
    const detailUrl = new URL(`/documents/${documentId}`, page.url()).toString();
    const draftResponse = await page.context().request.get(detailUrl);
    expect(draftResponse.status()).toBe(200);
    const draft = await draftResponse.json() as {
      id: string;
      status: string;
      title: string;
      customerName: string;
      issueDate: string;
      lineItems: Array<{ description: string; position: number; amounts: Record<string, number> }>;
      amounts: Record<string, number>;
    };
    expect(draft).toMatchObject({
      id: documentId,
      status: 'draft',
      title: 'Brand workshop',
      customerName: 'Alpen Studio',
      issueDate: '2026-10-14',
      lineItems: [
        { description: '', position: 1, amounts: { subtotalCents: 5997, discountCents: 1000, taxableCents: 4997, taxCents: 949, totalCents: 5946 } },
        { description: 'Print-ready files', position: 2, amounts: { subtotalCents: 500, discountCents: 0, taxableCents: 500, taxCents: 38, totalCents: 538 } },
      ],
      amounts: { subtotalCents: 6497, discountCents: 1000, taxableCents: 5497, taxCents: 987, totalCents: 6484 },
    });
    await mkdir('docs/evidence', { recursive: true });
    await writeFile('docs/evidence/issue-22-draft-document.json', `${JSON.stringify(draft, null, 2)}\n`);

    const pathsBeforeDraftPrint = requestPaths.length;
    await page.getByRole('button', { name: 'Print' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-print-calls', '1');
    expect(requestPaths.slice(pathsBeforeDraftPrint)).toEqual([]);
    expect(page.url()).toContain(`#/documents/${documentId}`);

    await page.setViewportSize({ width: 1000, height: 1200 });
    await page.emulateMedia({ media: 'print' });
    expect(await page.evaluate(() => window.matchMedia('print').matches)).toBe(true);
    await expect(page.locator('.app-topbar')).toBeHidden();
    await expect(page.locator('.back-link')).toBeHidden();
    for (const button of await page.locator('button').all()) await expect(button).toBeHidden();
    await expect(page.getByRole('button', { name: 'Add line item' })).toBeHidden();
    await expect(page.getByLabel('Document name')).toHaveValue('Brand workshop');
    await expect(page.getByLabel('Customer name')).toHaveValue('Alpen Studio');
    await expect(page.getByLabel('Issue date')).toHaveValue('2026-10-14');
    await expect(page.locator('.status-badge')).toHaveText('Draft');
    await expect(page.locator('.status-badge')).toHaveCSS('text-transform', 'uppercase');
    await expect(page.getByTestId('line-item')).toHaveCount(2);
    expect(await page.locator('.line-description input').evaluateAll(inputs => inputs.map(input => (input as HTMLInputElement).value)))
      .toEqual(['', 'Print-ready files']);
    await expect(page.locator('.line-math').nth(0)).toHaveText('€59.97 subtotal − €10.00 discount = €49.97 taxable + €9.49 tax');
    await expect(page.locator('.line-math').nth(1)).toHaveText('€5.00 subtotal − €0.00 discount = €5.00 taxable + €0.38 tax');
    await expect(page.locator('.amount-list')).toContainText('€64.97');
    await expect(page.locator('.amount-list')).toContainText('−€10.00');
    await expect(page.locator('.amount-list')).toContainText('€54.97');
    await expect(page.locator('.amount-list')).toContainText('€9.87');
    await expect(page.locator('.grand-total')).toContainText('€64.84');
    expect(await page.evaluate(() => getComputedStyle(document.body).color)).toBe('oklch(0 0 none)');
    await page.screenshot({ path: 'docs/evidence/issue-22-draft-print.png', fullPage: true });
    await test.info().attach('issue-22-draft-print.png', { path: 'docs/evidence/issue-22-draft-print.png', contentType: 'image/png' });

    await page.emulateMedia({ media: 'screen' });
    await page.getByLabel('Line description').nth(0).fill('Brand workshop');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByRole('status')).toHaveText('Draft saved.');
    await page.getByRole('button', { name: 'Finalize document' }).click();
    await expect(page.getByText('Document finalized. This snapshot cannot be changed.')).toBeVisible();
    await page.reload();
    await expect(page.getByLabel('Document name')).toHaveValue('Brand workshop');
    await expect(page.locator('.status-badge')).toHaveText('Finalized');
    await expect(page.getByTestId('line-item').nth(0).getByLabel('Line description')).toHaveValue('Brand workshop');

    const finalizedResponse = await page.context().request.get(detailUrl);
    expect(finalizedResponse.status()).toBe(200);
    const finalized = await finalizedResponse.json() as typeof draft;
    expect(finalized).toMatchObject({
      status: 'finalized',
      title: 'Brand workshop',
      customerName: 'Alpen Studio',
      issueDate: '2026-10-14',
      lineItems: [
        { description: 'Brand workshop', position: 1, amounts: { subtotalCents: 5997, discountCents: 1000, taxableCents: 4997, taxCents: 949, totalCents: 5946 } },
        { description: 'Print-ready files', position: 2, amounts: { subtotalCents: 500, discountCents: 0, taxableCents: 500, taxCents: 38, totalCents: 538 } },
      ],
      amounts: { subtotalCents: 6497, discountCents: 1000, taxableCents: 5497, taxCents: 987, totalCents: 6484 },
    });
    await writeFile('docs/evidence/issue-22-finalized-document.json', `${JSON.stringify(finalized, null, 2)}\n`);

    const pathsBeforeFinalPrint = requestPaths.length;
    await page.getByRole('button', { name: 'Print' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-print-calls', '1');
    expect(requestPaths.slice(pathsBeforeFinalPrint)).toEqual([]);
    await page.emulateMedia({ media: 'print' });
    await expect(page.locator('.status-badge')).toHaveText('Finalized');
    await expect(page.locator('.status-badge')).toHaveCSS('text-transform', 'uppercase');
    await expect(page.locator('.app-topbar')).toBeHidden();
    for (const button of await page.locator('button').all()) await expect(button).toBeHidden();
    await expect(page.getByLabel('Document name')).toHaveValue('Brand workshop');
    await expect(page.getByLabel('Customer name')).toHaveValue('Alpen Studio');
    await expect(page.getByLabel('Issue date')).toHaveValue('2026-10-14');
    await expect(page.locator('.line-math').nth(0)).toHaveText('€59.97 subtotal − €10.00 discount = €49.97 taxable + €9.49 tax');
    await expect(page.locator('.line-math').nth(1)).toHaveText('€5.00 subtotal − €0.00 discount = €5.00 taxable + €0.38 tax');
    await expect(page.locator('.amount-list')).toContainText('€64.97');
    await expect(page.locator('.amount-list')).toContainText('−€10.00');
    await expect(page.locator('.amount-list')).toContainText('€54.97');
    await expect(page.locator('.amount-list')).toContainText('€9.87');
    await expect(page.locator('.grand-total')).toContainText('€64.84');
    await page.screenshot({ path: 'docs/evidence/issue-22-finalized-print.png', fullPage: true });
    await test.info().attach('issue-22-finalized-print.png', { path: 'docs/evidence/issue-22-finalized-print.png', contentType: 'image/png' });

    await page.emulateMedia({ media: 'screen' });
    await page.reload();
    const reloadedResponse = await page.context().request.get(detailUrl);
    expect(reloadedResponse.status()).toBe(200);
    expect(await reloadedResponse.json()).toEqual(finalized);
    expect(requestPaths.filter(path => /\/(print|pdf)(?:\/|$)/i.test(path))).toEqual([]);
  } finally {
    await cleanupPool.query('DELETE FROM users WHERE email_canonical = $1', [email.toLowerCase()]);
  }
});

test('keeps dashboard, summary, and editor usable at 430px', async ({ page }) => {
  const email = `mobile-review-${randomUUID()}@example.com`;
  try {
    await page.setViewportSize({ width: 430, height: 932 });
    await createAccount(page, email);
    await expectNoHorizontalOverflow(page);
    await expect(page.getByRole('button', { name: 'Generate Summary' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'New document' })).toBeVisible();
    await mkdir('docs/evidence', { recursive: true });
    await page.screenshot({ path: 'docs/evidence/issue-22-dashboard-mobile.png', fullPage: true });

    await page.getByRole('button', { name: 'Generate Summary' }).click();
    const summary = page.getByRole('complementary', { name: 'Summary report' });
    await expect(summary).toBeVisible();
    await expect(summary.getByLabel('Summary start date')).toBeVisible();
    await expect(summary.getByLabel('Summary end date')).toBeVisible();
    await expectNoHorizontalOverflow(page);
    const summaryBounds = await summary.boundingBox();
    expect(summaryBounds).not.toBeNull();
    expect(summaryBounds!.x).toBeGreaterThanOrEqual(0);
    expect(summaryBounds!.x + summaryBounds!.width).toBeLessThanOrEqual(430);
    await page.screenshot({ path: 'docs/evidence/issue-22-summary-mobile.png', fullPage: true });
    await page.getByRole('button', { name: 'Close summary' }).click();
    await expect(summary).toBeHidden();

    await page.getByRole('button', { name: 'New document' }).click();
    await page.getByLabel('Document name').fill('Mobile review');
    await page.getByRole('button', { name: 'Add line item' }).click();
    const first = page.getByTestId('line-item').nth(0);
    await first.getByLabel('Line description').fill('Brand workshop');
    await first.getByLabel('Qty').fill('3');
    await first.getByLabel('Unit price €').fill('19.99');
    await first.getByLabel('Discount €').fill('10.00');
    await first.getByLabel('Tax %').fill('19.00');

    await page.getByRole('button', { name: 'Add line item' }).click();
    const second = page.getByTestId('line-item').nth(1);
    await second.getByLabel('Line description').fill('Remove me');
    await second.getByLabel('Qty').fill('2');
    await second.getByLabel('Unit price €').fill('2.50');
    await page.getByRole('button', { name: 'Remove line 2' }).click();
    await expect(page.getByTestId('line-item')).toHaveCount(1);
    await expect(first.getByLabel('Unit price €')).toHaveValue('19.99');
    await expect(first.locator('.line-math')).toHaveText('€59.97 subtotal − €10.00 discount = €49.97 taxable + €9.49 tax');
    await expect(first.locator('.line-sum strong')).toHaveText('€59.46');
    await expect(page.locator('.amount-list')).toContainText('€59.97');
    await expect(page.locator('.amount-list')).toContainText('−€10.00');
    await expect(page.locator('.amount-list')).toContainText('€49.97');
    await expect(page.locator('.amount-list')).toContainText('€9.49');
    await expect(page.locator('.grand-total')).toContainText('€59.46');
    await expectNoHorizontalOverflow(page);

    const layout = await page.evaluate(() => {
      const lineFields = document.querySelector('.line-fields')!.getBoundingClientRect();
      const lineTotal = document.querySelector('.line-sum strong')!.getBoundingClientRect();
      const viewportWidth = document.documentElement.clientWidth;
      const inputRightEdges = [...document.querySelectorAll('.metadata-fields input, .line-fields input')]
        .map(input => input.getBoundingClientRect().right);
      const amountRightEdges = [...document.querySelectorAll('.amount-list dd, .grand-total strong')]
        .map(amount => amount.getBoundingClientRect().right);
      return {
        lineFieldsRight: lineFields.right,
        lineTotalRight: lineTotal.right,
        viewportWidth,
        inputRightEdges,
        amountRightEdges,
      };
    });
    expect(Math.abs(layout.lineFieldsRight - layout.lineTotalRight)).toBeLessThan(2);
    expect(Math.max(...layout.inputRightEdges)).toBeLessThanOrEqual(layout.viewportWidth);
    expect(Math.max(...layout.amountRightEdges)).toBeLessThanOrEqual(layout.viewportWidth);
    await page.screenshot({ path: 'docs/evidence/issue-22-editor-mobile.png', fullPage: true });
    await test.info().attach('issue-22-editor-mobile.png', { path: 'docs/evidence/issue-22-editor-mobile.png', contentType: 'image/png' });
  } finally {
    await cleanupPool.query('DELETE FROM users WHERE email_canonical = $1', [email.toLowerCase()]);
  }
});

import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

const amounts = { subtotalCents: 6497, discountCents: 1000, taxableCents: 5497, taxCents: 987, totalCents: 6484 };
const documentFixture = {
  id: 'print-layout', title: 'Brand workshop', customerName: 'Alpen Studio', issueDate: '2026-10-14',
  createdAt: '2026-10-14T12:00:00Z', updatedAt: '2026-10-14T12:00:00Z', finalizedAt: null, amounts,
  lineItems: [
    { id: 'line-1', position: 1, description: 'Brand workshop', quantity: 3, unitPriceCents: 1999, discountCents: 1000, taxRateBasisPoints: 1900,
      amounts: { subtotalCents: 5997, discountCents: 1000, taxableCents: 4997, taxCents: 949, totalCents: 5946 } },
    { id: 'line-2', position: 2, description: 'Print-ready files', quantity: 2, unitPriceCents: 250, discountCents: 0, taxRateBasisPoints: 750,
      amounts: { subtotalCents: 500, discountCents: 0, taxableCents: 500, taxCents: 38, totalCents: 538 } },
  ],
};

for (const status of ['draft', 'finalized'] as const) {
  test(`Ledger ${status} print layout on A4 and Letter`, async ({ page }, testInfo) => {
    await page.route('**/auth/session', route => route.fulfill({ json: { user: { id: 'print-user', email: 'print@example.com' } } }));
    await page.route('**/documents/print-layout', route => route.fulfill({ json: { ...documentFixture, status } }));
    await page.goto('/#/documents/print-layout');
    await expect(page.getByLabel('Document name')).toHaveValue('Brand workshop');
    await expect(page.locator('.print-value').first()).toBeHidden();
    await page.emulateMedia({ media: 'print' });
    await page.setViewportSize({ width: 794, height: 1123 });
    await expect(page.locator('.app-topbar')).toBeHidden();
    await expect(page.locator('.document-save-actions')).toBeHidden();
    await expect(page.locator('.grand-total')).toContainText('€64.84');
    for (const actions of await page.locator('.line-actions').all()) await expect(actions).toBeHidden();
    await expect(page.locator('.status-badge')).toHaveCSS('text-transform', 'none');
    // A paper page must retain the reference's three details columns, five numeric
    // columns, and top-right status even when printing from a phone viewport.
    for (const width of [430, 794, 816, 1000]) {
      await page.setViewportSize({ width, height: 1123 });
      const layout = await page.evaluate(() => {
        const rect = (selector: string) => document.querySelector(selector)!.getBoundingClientRect().toJSON();
        return {
          details: [...document.querySelectorAll('.metadata-fields .print-value')].map(item => item.getBoundingClientRect().y),
          numbers: [...document.querySelectorAll('.line-item:first-of-type .line-fields .print-value')].map(item => item.getBoundingClientRect().y),
          title: rect('.editor-title'), badge: rect('.status-badge'), fields: rect('.line-fields'), total: rect('.line-sum'),
          width: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth,
        };
      });
      expect(new Set(layout.details).size).toBe(1);
      expect(new Set(layout.numbers).size).toBe(1);
      expect(Math.abs(layout.badge.y - layout.title.y)).toBeLessThan(2);
      expect(Math.abs(layout.fields.right - layout.total.right)).toBeLessThan(2);
      expect(layout.scrollWidth).toBeLessThanOrEqual(layout.width);
    }
    await page.setViewportSize({ width: 794, height: 1123 });
    for (const format of ['A4', 'Letter'] as const) {
      await page.pdf({ path: testInfo.outputPath(`${status}-${format}.pdf`), format, printBackground: true });
    }
    await page.screenshot({ path: testInfo.outputPath(`${status}-print.png`), fullPage: true });
  });
}

test('selected Ledger prototype print reference', async ({ page }, testInfo) => {
  await page.route('**/print-reference/**', async route => {
    const file = new URL(route.request().url()).pathname.split('/').at(-1)!;
    if (!['index.html', 'prototype.css', 'prototype.js'].includes(file)) return route.abort();
    await route.fulfill({ body: await readFile(`prototype/dashboard-editor/${file}`), contentType: file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : 'text/html' });
  });
  await page.goto('/print-reference/index.html?variant=B#document=PD-1048');
  await expect(page.getByRole('heading', { name: 'Brand workshop', exact: true })).toBeVisible();
  await page.emulateMedia({ media: 'print' });
  await page.setViewportSize({ width: 794, height: 1123 });
  await page.screenshot({ path: testInfo.outputPath('prototype-print.png'), fullPage: true });
  await page.pdf({ path: testInfo.outputPath('prototype-A4.pdf'), format: 'A4', margin: { top: '14mm', right: '14mm', bottom: '14mm', left: '14mm' }, printBackground: true });
});


test('wraps current values and keeps long printed lines together across pages', async ({ page }, testInfo) => {
  const description = 'Brand workshop with research, strategy, visual identity and production handover for the entire customer team';
  const fixture = {
    ...documentFixture, status: 'draft',
    lineItems: Array.from({ length: 18 }, (_, index) => ({ ...documentFixture.lineItems[0], id: `long-${index}`, position: index + 1, description: `${index + 1}. ${description}` })),
  };
  await page.route('**/auth/session', route => route.fulfill({ json: { user: { id: 'long-print-user', email: 'print@example.com' } } }));
  await page.route('**/documents/print-layout', route => route.fulfill({ json: fixture }));
  await page.goto('/#/documents/print-layout');
  await expect(page.getByLabel('Document name')).toHaveValue('Brand workshop');
  const customer = 'Alpen Studio international customer services and communications department';
  await page.getByLabel('Customer name').fill(customer);
  await page.getByLabel('Line description').first().fill(description + ' — updated before printing');
  await page.setViewportSize({ width: 688, height: 1000 });
  await page.emulateMedia({ media: 'print' });
  await expect(page.locator('.metadata-fields .print-value').nth(1)).toHaveText(customer);
  await expect(page.locator('.line-description .print-value').first()).toHaveText(description + ' — updated before printing');
  const wrapped = await page.locator('.metadata-fields .print-value').nth(1).evaluate(element => ({ height: element.clientHeight, scroll: element.scrollWidth, width: element.clientWidth }));
  expect(wrapped.height).toBeGreaterThan(35);
  expect(wrapped.scroll).toBeLessThanOrEqual(wrapped.width);
  await expect(page.getByTestId('line-item').first()).toHaveCSS('break-inside', 'avoid');
  await expect(page.locator('.breakdown')).toHaveCSS('break-inside', 'avoid');
  await page.pdf({ path: testInfo.outputPath('long-draft-A4.pdf'), format: 'A4', printBackground: true });
});

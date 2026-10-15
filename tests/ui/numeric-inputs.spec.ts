import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.route('**/auth/session', route => route.fulfill({
    json: { user: { id: 'numeric-input-test', email: 'numeric@example.com' } },
  }));
  await page.goto('/#/documents/new');
  await page.getByRole('button', { name: 'Add line item' }).click();
});

test('numeric fields reject letters typed or inserted while keeping valid edits', async ({ page }) => {
  for (const label of ['Qty', 'Unit price €', 'Discount €', 'Tax %']) {
    const input = page.getByLabel(label, { exact: true });
    await input.fill('12');
    await input.press('End');
    await input.pressSequentially('aZeE');
    await expect(input).toHaveValue('12');

    // insertText exercises the input event used by paste, without key events.
    await page.keyboard.insertText('abc34');
    await expect(input).toHaveValue('12');
    await page.keyboard.insertText('3');
    await expect(input).toHaveValue('123');

    await input.fill('');
    await expect(input).toHaveValue('');
    await input.pressSequentially('45');
    await expect(input).toHaveValue('45');
  }

  for (const label of ['Unit price €', 'Discount €', 'Tax %']) {
    const input = page.getByLabel(label, { exact: true });
    await input.fill('');
    await input.pressSequentially('12.');
    await expect(input).toHaveValue('12.');
    await input.pressSequentially('50');
    await expect(input).toHaveValue('12.50');
    await input.fill('0,25');
    await expect(input).toHaveValue('0,25');
  }
});

test('numeric input restrictions preserve domain validation', async ({ page }) => {
  await page.getByLabel('Qty', { exact: true }).fill('0');
  await page.getByLabel('Unit price €').fill('-1');
  await page.getByLabel('Discount €').fill('1.234');
  await page.getByLabel('Tax %').fill('100.01');
  await page.getByRole('button', { name: 'Save as draft' }).click();

  await expect(page.getByText('Enter a positive whole quantity.')).toBeVisible();
  await expect(page.getByText('Enter a EUR amount with up to two decimals.')).toHaveCount(2);
  await expect(page.getByText('Enter a tax rate from 0 to 100.00%.')).toBeVisible();
});

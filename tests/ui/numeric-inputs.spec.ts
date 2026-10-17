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

test('numeric fields enforce non-scientific number syntax for typing and paste', async ({ page }) => {
  for (const label of ['Discount €', 'Unit price €', 'Tax %', 'Qty']) {
    const input = page.getByLabel(label, { exact: true });
    const initial = label === 'Qty' ? '12' : '0.00';
    await input.fill(initial);
    await input.press('End');
    await input.press('.');
    await expect(input).toHaveValue(initial);
    await input.press('Space');
    await expect(input).toHaveValue(initial);

    for (const invalid of ['0.00.', '1..2', '1,2.3', '1,,2', '1 2', ' 12', '12 ', '1\t2', '1\u00a02', '1e3', '1E-3', '1+2', '1-2', '--2', '++2']) {
      await input.selectText();
      await page.keyboard.insertText(invalid);
      await expect(input).toHaveValue(initial);
    }
    await input.selectText();
    await page.keyboard.insertText('24');
    await expect(input).toHaveValue('24');
    await input.press('Backspace');
    await expect(input).toHaveValue('2');
  }

  const quantity = page.getByLabel('Qty', { exact: true });
  await quantity.fill('2.5');
  await expect(quantity).toHaveValue('2');
  await quantity.fill('2,5');
  await expect(quantity).toHaveValue('2');

  const discount = page.getByLabel('Discount €');
  await discount.fill('12.50');
  await discount.press('Home');
  await discount.press('ArrowRight');
  await discount.press('.');
  await expect(discount).toHaveValue('12.50');
  await discount.press('Home');
  await discount.press('ArrowRight');
  await discount.press('Shift+End');
  await page.keyboard.insertText('3,25');
  await expect(discount).toHaveValue('13,25');
});

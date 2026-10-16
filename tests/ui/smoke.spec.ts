import { expect, test } from '@playwright/test';

test('served React app presents sign-in to signed-out visitors', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Sign in to your workspace' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Email address' })).toBeVisible();
  await expect(page.getByLabel('Password')).toBeVisible();
});

test('malformed document hash keeps app usable across reload and hash changes', async ({ page }) => {
  const pageErrors: Error[] = [];
  page.on('pageerror', error => pageErrors.push(error));

  await page.goto('/#/documents/%E0%A4');
  await expect(page.getByRole('heading', { name: 'Sign in to your workspace' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Sign in to your workspace' })).toBeVisible();
  await page.goto('/#/documents');
  await page.evaluate(() => { window.location.hash = '#/documents/%'; });
  await expect(page.getByRole('heading', { name: 'Sign in to your workspace' })).toBeVisible();
  expect(pageErrors).toEqual([]);
});

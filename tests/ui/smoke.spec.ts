import { expect, test } from '@playwright/test';

test('served React app presents registration to signed-out visitors', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Create your private workspace' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Email address' })).toBeVisible();
  await expect(page.getByLabel('Password')).toBeVisible();
});

import { expect, test } from '@playwright/test';

test('served React app checks its service through a visible control', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Pricing documents' })).toBeVisible();
  const button = page.getByRole('button', { name: 'Check service' });
  await expect(button).toBeVisible();
  await button.click({ force: true });
  await expect(page.getByRole('status')).toHaveText('Database connected');
});

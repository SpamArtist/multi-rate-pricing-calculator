import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { migrationPool } from '../support/db-fixture.js';

test.afterAll(async () => { await migrationPool.end(); });

test('registration form shows inline validation, then opens private workspace', async ({ page }) => {
  const email = `owner-${randomUUID()}@example.com`;
  try {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Create your private workspace' })).toBeVisible();

    const emailField = page.getByRole('textbox', { name: 'Email address' });
    const passwordField = page.getByLabel('Password');
    await emailField.fill('not-an-email');
    await emailField.blur();
    await expect(page.getByText('Enter a valid email address.')).toBeVisible();

    await passwordField.fill('abcde');
    await passwordField.blur();
    await expect(page.getByText('Use 6 to 10 Unicode code points with no internal whitespace.')).toBeVisible();

    await passwordField.fill('A🔐b$cD');
    await expect(passwordField).toHaveAttribute('aria-invalid', 'false');
    await passwordField.fill('ab\u0085cde');
    await expect(passwordField).toHaveAttribute('aria-invalid', 'true');

    await emailField.fill(email);
    await passwordField.fill('A🔐b$cD');
    await expect(passwordField).toHaveAttribute('aria-invalid', 'false');
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('heading', { name: `Welcome, ${email}` })).toBeVisible();
    await expect(page.getByText('Your private pricing workspace is ready.')).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: `Welcome, ${email}` })).toBeVisible();
  } finally {
    await migrationPool.query('DELETE FROM users WHERE email_canonical = $1', [email.toLowerCase()]);
  }
});

test('browser API request bypass still receives authoritative server validation', async ({ request }) => {
  const response = await request.post('/auth/sign-up', {
    data: { email: 'bypass', password: 'abcde' },
  });
  expect(response.status()).toBe(422);
  const payload = await response.json() as { error: { code: string; fields: Record<string, string> } };
  expect(payload.error.code).toBe('validation_failed');
  expect(payload.error.fields).toHaveProperty('email');
  expect(payload.error.fields).toHaveProperty('password');
});

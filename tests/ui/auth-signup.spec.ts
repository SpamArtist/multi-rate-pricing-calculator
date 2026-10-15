import { createHash, randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import argon2 from 'argon2';
import { migrationPool } from '../support/db-fixture.js';

test('registration form shows inline validation, then opens private workspace', async ({ page }) => {
  const email = `owner-${randomUUID()}@example.com`;
  try {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Sign in to your workspace' })).toBeVisible();
    await page.getByRole('button', { name: 'Create account' }).click();
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
    await expect(page.getByRole('heading', { name: 'Documents', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'New document' })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Documents', exact: true })).toBeVisible();
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

  const signInResponse = await request.post('/auth/sign-in', {
    data: { email: 'bypass', password: 'abcde' },
  });
  expect(signInResponse.status()).toBe(422);
  const signInPayload = await signInResponse.json() as { error: { code: string; fields: Record<string, string> } };
  expect(signInPayload.error.code).toBe('validation_failed');
  expect(signInPayload.error.fields).toHaveProperty('email');
  expect(signInPayload.error.fields).toHaveProperty('password');
});

test('sign-in survives reload, device logout stays independent, and expiry returns to sign-in', async ({ page, browser }) => {
  const id = randomUUID();
  const email = `returning-${id}@example.com`;
  const password = 'A🔐b$cD';
  const passwordHash = await argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
    hashLength: 32,
  });
  await migrationPool.query(
    'INSERT INTO users (id, email_display, email_canonical, password_hash) VALUES ($1, $2, $3, $4)',
    [id, email, email, passwordHash],
  );
  const secondContext = await browser.newContext();
  const secondPage = await secondContext.newPage();
  const webOrigin = `http://127.0.0.1:${process.env.WEB_PORT ?? 4173}/`;

  try {
    await page.goto('/');
    await page.getByLabel('Email address').fill(email);
    await page.getByLabel('Password').fill(password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('heading', { name: 'Documents', exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Documents', exact: true })).toBeVisible();

    await secondPage.goto(webOrigin);
    await secondPage.getByLabel('Email address').fill(email);
    await secondPage.getByLabel('Password').fill(password);
    await secondPage.getByRole('button', { name: 'Sign in' }).click();
    await expect(secondPage.getByRole('heading', { name: 'Documents', exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByRole('heading', { name: 'Sign in to your workspace' })).toBeVisible();
    await secondPage.reload();
    await expect(secondPage.getByRole('heading', { name: 'Documents', exact: true })).toBeVisible();

    const sessionCookie = (await secondContext.cookies()).find(cookie => cookie.name === '__Host-session');
    expect(sessionCookie).toBeDefined();
    const tokenHash = createHash('sha256').update(sessionCookie!.value).digest('hex');
    await migrationPool.query(
      "UPDATE sessions SET expires_at = created_at + interval '1 millisecond' WHERE token_hash = $1",
      [tokenHash],
    );
    await secondPage.reload();
    await expect(secondPage.getByRole('heading', { name: 'Sign in to your workspace' })).toBeVisible();
  } finally {
    await secondContext.close();
    await migrationPool.query('DELETE FROM users WHERE id = $1', [id]);
  }
});

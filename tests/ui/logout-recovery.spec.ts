import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { migrationPool } from '../support/db-fixture.js';

for (const failure of ['http', 'network', 'expired-session'] as const) {
  test(`unsuccessful logout preserves draft recovery (${failure}); confirmed logout clears it`, async ({ page }) => {
    const email = `logout-recovery-${randomUUID()}@example.com`;
    try {
      await page.goto('/');
      await page.getByRole('button', { name: 'Create account' }).click();
      await page.getByLabel('Email address').fill(email);
      await page.getByLabel('Password').fill('A🔐b$cD');
      await page.getByRole('button', { name: 'Create account' }).click();
      await page.getByRole('button', { name: 'New document' }).click();
      await page.getByLabel('Document name').fill('Recover after failed logout');
      await page.getByRole('button', { name: 'Add line item' }).click();
      await page.getByLabel('Line description').fill('Keep this local line');

      const session = await (await page.request.get('/auth/session')).json() as { user: { id: string } };
      const prefix = `pricing-calculator:editor:${session.user.id}:`;
      let mutationId = '';
      await page.route('**/documents/draft-save', async route => {
        mutationId = (route.request().postDataJSON() as { mutationId: string }).mutationId;
        const response = await route.fetch();
        expect(response.status()).toBe(201);
        await route.abort('failed');
      });
      await page.getByRole('button', { name: 'Save as draft' }).click();
      await expect(page.getByRole('alert')).toContainText('Connection failed');

      const readRecovery = () => page.evaluate(ownerPrefix => Object.fromEntries(
        Object.entries(sessionStorage).filter(([key]) => key.startsWith(ownerPrefix)),
      ), prefix);
      const recoveryBeforeLogout = await readRecovery();
      expect(mutationId).not.toBe('');
      expect(JSON.stringify(recoveryBeforeLogout)).toContain(mutationId);
      expect(JSON.stringify(recoveryBeforeLogout)).toContain('Keep this local line');

      await page.route('**/auth/logout', async route => {
        if (failure === 'network') return route.abort('failed');
        await route.fulfill({
          status: failure === 'expired-session' ? 401 : 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: { message: 'Logout failed.' } }),
        });
      });
      await page.getByRole('button', { name: 'Sign out' }).click();
      if (failure === 'expired-session') {
        await expect(page.getByRole('heading', { name: 'Sign in to your workspace' })).toBeVisible();
      } else {
        await expect(page.getByRole('button', { name: 'Sign out' })).toBeEnabled();
        await expect(page.getByRole('alert', { name: 'Account error' })).toHaveText(
          failure === 'network' ? 'Connection failed. Check your network and try again.' : 'Logout failed.',
        );
      }
      expect(await readRecovery()).toEqual(recoveryBeforeLogout);

      if (failure === 'expired-session') {
        await page.getByLabel('Email address').fill(email);
        await page.getByLabel('Password').fill('A🔐b$cD');
        await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      } else {
        await page.reload();
      }
      await expect(page.getByLabel('Document name')).toHaveValue('Recover after failed logout');
      await expect(page.getByLabel('Line description')).toHaveValue('Keep this local line');
      expect(await readRecovery()).toEqual(recoveryBeforeLogout);

      if (failure !== 'expired-session') {
        await page.getByRole('button', { name: 'Sign out' }).click();
        await expect(page.getByRole('alert', { name: 'Account error' })).toBeVisible();
      }
      await page.unroute('**/auth/logout');
      let releaseLogout!: () => void;
      const logoutReleased = new Promise<void>(resolve => { releaseLogout = resolve; });
      await page.route('**/auth/logout', async route => {
        await logoutReleased;
        await route.continue();
      });
      try {
        await page.getByRole('button', { name: 'Sign out' }).click();
        await expect(page.getByRole('button', { name: 'Signing out…' })).toBeDisabled();
        await expect(page.getByRole('alert', { name: 'Account error' })).toHaveCount(0);
        expect(await readRecovery()).toEqual(recoveryBeforeLogout);
      } finally {
        releaseLogout();
      }
      await expect(page.getByRole('heading', { name: 'Sign in to your workspace' })).toBeVisible();
      await expect(page.getByRole('alert')).toHaveCount(0);
      expect(await readRecovery()).toEqual({});
    } finally {
      await migrationPool.query('DELETE FROM users WHERE email_canonical = $1', [email.toLowerCase()]);
    }
  });
}

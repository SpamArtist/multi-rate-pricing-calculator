import { expect, test } from '@playwright/test';

for (const returningOwner of [false, true]) {
  test(`late expired response cannot invalidate ${returningOwner ? 'the same owner’s new' : 'another owner’s'} session`, async ({ page }) => {
    const originalUser = { id: 'original-owner', email: 'original@example.com' };
    const nextUser = returningOwner ? originalUser : { id: 'next-owner', email: 'next@example.com' };
    let releaseResponse!: () => void;
    const released = new Promise<void>(resolve => { releaseResponse = resolve; });
    let requestStarted!: () => void;
    const started = new Promise<void>(resolve => { requestStarted = resolve; });

    await page.route('**/auth/session', route => route.fulfill({ json: { user: originalUser } }));
    await page.route('**/auth/logout', route => route.fulfill({ status: 204 }));
    await page.route('**/auth/sign-in', route => route.fulfill({ json: { user: nextUser } }));
    await page.route('**/documents', route => route.fulfill({
      json: { items: [], page: 1, pageSize: 25, totalItems: 0, totalPages: 0 },
    }));
    await page.route('**/documents/old-request', async route => {
      requestStarted();
      await released;
      await route.fulfill({
        status: 401,
        json: { error: { code: 'unauthenticated', message: 'Sign in to continue.' } },
      });
    });

    try {
      await page.goto('/#/documents/old-request');
      await started;
      await page.getByRole('button', { name: 'Sign out', exact: true }).click();
      await page.getByLabel('Email address').fill(nextUser.email);
      await page.getByLabel('Password').fill('abcdef');
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await expect(page.getByText(nextUser.email, { exact: true })).toBeVisible();

      const responseFinished = page.waitForEvent('requestfinished', request => request.url().endsWith('/documents/old-request'));
      releaseResponse();
      await responseFinished;
      // Flush rendering after the old response has reached its fetch continuation.
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await expect(page.getByText(nextUser.email, { exact: true })).toBeVisible();
      await expect(page.getByText('Your session expired. Sign in to resume editing.')).toHaveCount(0);
      await page.getByRole('button', { name: 'New document' }).click();
      await expect(page.getByLabel('Document name')).toBeVisible();
    } finally {
      releaseResponse();
      await page.unrouteAll({ behavior: 'wait' });
    }
  });
}

test('an expired response from the current session still requests sign-in', async ({ page }) => {
  await page.route('**/auth/session', route => route.fulfill({
    json: { user: { id: 'current-owner', email: 'current@example.com' } },
  }));
  await page.route('**/documents/expired', route => route.fulfill({
    status: 401,
    json: { error: { code: 'unauthenticated', message: 'Sign in to continue.' } },
  }));
  await page.goto('/#/documents/expired');
  await expect(page.getByRole('heading', { name: 'Sign in to your workspace' })).toBeVisible();
  await expect(page.getByText('Your session expired. Sign in to resume editing.')).toBeVisible();
});

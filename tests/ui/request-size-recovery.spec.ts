import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { DraftSaveBody } from '../../src/shared/types/api-contracts.js';
import { migrationPool } from '../support/db-fixture.js';

test('an oversized draft can be corrected and saved without replaying the rejected payload', async ({ page }) => {
  const email = `request-size-${randomUUID()}@example.com`;
  const requests: DraftSaveBody[] = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/documents/draft-save') {
      requests.push(request.postDataJSON() as DraftSaveBody);
    }
  });
  try {
    await page.goto('/');
    await page.getByRole('button', { name: 'Create account' }).click();
    await page.getByLabel('Email address').fill(email);
    await page.getByLabel('Password').fill('A🔐b$cD');
    await page.getByRole('button', { name: 'Create account' }).click();
    await page.getByRole('button', { name: 'New document' }).click();
    await page.getByLabel('Document name').fill('Oversized draft');
    await page.getByRole('button', { name: 'Add line item' }).click();
    await page.getByLabel('Line description').fill('x'.repeat(70_000));

    const rejected = page.waitForResponse('**/documents/draft-save');
    await page.getByRole('button', { name: 'Save as draft' }).click();
    expect((await rejected).status()).toBe(413);
    await expect(page.getByRole('alert')).toContainText('too large');
    await expect(page.getByLabel('Line description')).toBeEnabled();

    await page.getByLabel('Line description').fill('Corrected line');
    const accepted = page.waitForResponse('**/documents/draft-save');
    await page.getByRole('button', { name: 'Save as draft' }).click();
    expect((await accepted).status()).toBe(201);
    await expect(page).toHaveURL(/#\/documents\/[0-9a-f-]+$/i);
    expect(requests).toHaveLength(2);
    expect(requests[1].mutationId).not.toBe(requests[0].mutationId);
    expect(requests[1].lineItems[0].description).toBe('Corrected line');
    await page.reload();
    await expect(page.getByLabel('Line description')).toHaveValue('Corrected line');
  } finally {
    await migrationPool.query('DELETE FROM users WHERE email_canonical = $1', [email]);
  }
});

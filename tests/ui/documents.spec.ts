import { createHash, randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { migrationPool } from '../support/db-fixture.js';

test.describe.configure({ mode: 'serial' });

test.afterAll(async () => { await migrationPool.end(); });

test('starts locally, saves a draft, reopens from Documents, and verifies persisted API values', async ({ page }) => {
  const email = `draft-${randomUUID()}@example.com`;
  const password = 'A🔐b$cD';
  try {
    await page.goto('/');
    await page.getByRole('button', { name: 'Create account' }).click();
    await page.getByLabel('Email address').fill(email);
    await page.getByLabel('Password').fill(password);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('heading', { name: 'Documents', exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'New document' }).click();
    await expect(page.getByRole('heading', { name: 'Untitled document' })).toBeVisible();
    const title = page.getByLabel('Document name');
    const customer = page.getByLabel('Customer name');
    const issueDate = page.getByLabel('Issue date');
    const expectedToday = await page.evaluate(() => {
      const date = new Date();
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    });
    await expect(issueDate).toHaveValue(expectedToday);
    await expect(page.getByRole('button', { name: 'Duplicate' })).toHaveCount(0);

    await customer.fill('Retained customer');
    await title.fill('');
    await issueDate.fill('');
    await page.getByRole('button', { name: 'Save as draft' }).click();
    await expect(page.getByText('Enter a document name.')).toBeVisible();
    await expect(page.getByText('Enter a valid issue date.')).toBeVisible();
    await expect(title).toHaveValue('');
    await expect(issueDate).toHaveValue('');
    await expect(customer).toHaveValue('Retained customer');

    await title.fill('Brand workshop');
    await issueDate.fill('2026-10-14');
    await page.getByRole('button', { name: 'Save as draft' }).click();
    await expect(page.getByRole('heading', { name: 'Brand workshop' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save changes' })).toBeVisible();

    await page.getByRole('button', { name: 'All documents' }).click();
    await expect(page.getByRole('link', { name: 'Brand workshop' })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Documents', exact: true })).toBeVisible();
    await page.getByRole('link', { name: 'Brand workshop' }).click();
    await expect(page.getByRole('heading', { name: 'Brand workshop' })).toBeVisible();
    await expect(customer).toHaveValue('Retained customer');

    await customer.fill('Alpen Studio');
    await issueDate.fill('2026-11-02');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByRole('status')).toHaveText('Draft saved.');
    await expect(page.getByRole('heading', { name: 'Brand workshop' })).toBeVisible();
    await page.screenshot().then(body => test.info().attach('issue-14-ledger-editor.png', { body, contentType: 'image/png' }));
    await page.setViewportSize({ width: 390, height: 844 });
    const mobileWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(mobileWidth).toBeLessThanOrEqual(390);
    await page.screenshot().then(body => test.info().attach('issue-14-ledger-editor-mobile.png', { body, contentType: 'image/png' }));

    const documentsResponse = await page.context().request.get(new URL('/documents', page.url()).toString());
    expect(documentsResponse.status()).toBe(200);
    const list = await documentsResponse.json() as { items: Array<{ id: string; title: string }> };
    const saved = list.items.find(item => item.title === 'Brand workshop');
    expect(saved).toBeDefined();
    await expect(page.locator('body')).not.toContainText(saved!.id);
    const persistedResponse = await page.context().request.get(new URL(`/documents/${saved!.id}`, page.url()).toString());
    expect(persistedResponse.status()).toBe(200);
    const persisted = await persistedResponse.json() as {
      id: string;
      title: string;
      customerName: string;
      issueDate: string;
      lineItems: unknown[];
      amounts: { totalCents: number };
      ownerId?: string;
    };
    expect(persisted).toMatchObject({
      id: saved!.id,
      title: 'Brand workshop',
      customerName: 'Alpen Studio',
      issueDate: '2026-11-02',
      lineItems: [],
      amounts: { totalCents: 0 },
    });
    expect(persisted).not.toHaveProperty('ownerId');
    await test.info().attach('issue-14-persisted-document.json', {
      body: JSON.stringify(persisted, null, 2), contentType: 'application/json',
    });

    await page.getByRole('button', { name: 'All documents' }).click();
    await expect(page.getByRole('cell', { name: 'Alpen Studio' })).toBeVisible();
    await expect(page.getByRole('cell', { name: '2 Nov 2026' })).toBeVisible();
  } finally {
    await migrationPool.query('DELETE FROM users WHERE email_canonical = $1', [email.toLowerCase()]);
  }
});

test('saves incomplete new document, repairs it, finalizes snapshot, and reloads disabled inputs', async ({ page }) => {
  const email = `finalize-ui-${randomUUID()}@example.com`;
  const password = 'A🔐b$cD';
  try {
    await page.goto('/');
    await page.getByRole('button', { name: 'Create account' }).click();
    await page.getByLabel('Email address').fill(email);
    await page.getByLabel('Password').fill(password);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('heading', { name: 'Documents', exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'New document' }).click();
    await page.getByLabel('Document name').fill('Brand workshop');
    await page.getByRole('button', { name: 'Add line item' }).click();
    const firstLine = page.getByTestId('line-item').nth(0);
    await firstLine.getByLabel('Qty').fill('3');
    await firstLine.getByLabel('Unit price €').fill('19.99');
    await firstLine.getByLabel('Discount €').fill('10.00');
    await firstLine.getByLabel('Tax %').fill('19.00');
    await page.getByRole('button', { name: 'Add line item' }).click();
    const secondLine = page.getByTestId('line-item').nth(1);
    await secondLine.getByLabel('Line description').fill('Print-ready files');
    await secondLine.getByLabel('Qty').fill('2');
    await secondLine.getByLabel('Unit price €').fill('2.50');
    await secondLine.getByLabel('Tax %').fill('7.50');

    await page.getByRole('button', { name: 'Finalize document' }).click();
    await expect(page).toHaveURL(/#\/documents\/[0-9a-f-]+$/i);
    const documentId = new URL(page.url()).hash.split('/').at(-1)!;
    await expect(page.getByLabel('Customer name')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByText('Enter a customer name.')).toBeVisible();
    await expect(firstLine.getByLabel('Line description')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByText('Enter a line description.')).toBeVisible();
    await expect(page.getByLabel('Document name')).toHaveValue('Brand workshop');
    await expect(firstLine.getByLabel('Unit price €')).toHaveValue('19.99');

    const draftResponse = await page.context().request.get(new URL(`/documents/${documentId}`, page.url()).toString());
    expect(draftResponse.status()).toBe(200);
    const draft = await draftResponse.json() as { status: string; lineItems: unknown[] };
    expect(draft).toMatchObject({ status: 'draft', lineItems: [{}, {}] });

    await page.getByLabel('Customer name').fill('Alpen Studio');
    await firstLine.getByLabel('Line description').fill('Brand workshop');
    await page.getByRole('button', { name: 'Finalize document' }).click();
    await expect(page.getByText('Document finalized. This snapshot cannot be changed.')).toBeVisible();
    await expect(page.getByLabel('Document name')).toBeDisabled();
    await expect(page.getByLabel('Customer name')).toBeDisabled();
    await expect(page.getByLabel('Issue date')).toBeDisabled();
    await expect(page.getByLabel('Line description').nth(0)).toBeDisabled();
    await expect(page.getByLabel('Unit price €').nth(1)).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Finalize document' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Save changes' })).toHaveCount(0);

    await page.reload();
    await expect(page.getByText('Fixed snapshot', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Document name')).toHaveValue('Brand workshop');
    await expect(page.getByLabel('Document name')).toBeDisabled();
    await expect(page.getByLabel('Customer name')).toHaveValue('Alpen Studio');
    await expect(page.getByLabel('Customer name')).toBeDisabled();
    await expect(page.getByTestId('line-item')).toHaveCount(2);
    await expect(page.getByLabel('Line description').nth(0)).toHaveValue('Brand workshop');
    await expect(page.getByLabel('Line description').nth(0)).toBeDisabled();
    await expect(page.locator('.grand-total')).toContainText('64.84');

    const snapshotResponse = await page.context().request.get(new URL(`/documents/${documentId}`, page.url()).toString());
    expect(snapshotResponse.status()).toBe(200);
    const snapshot = await snapshotResponse.json() as {
      status: string; finalizedAt: string | null;
      lineItems: Array<{ amounts: Record<string, number> }>;
      amounts: Record<string, number>;
    };
    expect(snapshot).toMatchObject({
      status: 'finalized', finalizedAt: expect.any(String),
      lineItems: [
        { amounts: { subtotalCents: 5997, discountCents: 1000, taxableCents: 4997, taxCents: 949, totalCents: 5946 } },
        { amounts: { subtotalCents: 500, discountCents: 0, taxableCents: 500, taxCents: 38, totalCents: 538 } },
      ],
      amounts: { subtotalCents: 6497, discountCents: 1000, taxableCents: 5497, taxCents: 987, totalCents: 6484 },
    });
    await test.info().attach('issue-17-finalized-snapshot.json', {
      body: JSON.stringify(snapshot, null, 2), contentType: 'application/json',
    });

    const finalizedSourceUrl = page.url();
    const localToday = await page.evaluate(() => {
      const date = new Date();
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    });
    await expect(page.getByRole('button', { name: 'Duplicate' })).toBeVisible();
    await page.getByRole('button', { name: 'Duplicate' }).click();
    await expect(page).toHaveURL(finalizedSourceUrl);
    await expect(page.getByRole('status')).toHaveText('Draft duplicated.');
    const copyLink = page.getByRole('link', { name: 'Open copy' });
    await expect(copyLink).toBeVisible();
    const copyHref = await copyLink.getAttribute('href');
    const copyId = decodeURIComponent(copyHref!.split('/').at(-1)!);
    await copyLink.click();
    await expect(page.getByLabel('Issue date')).toHaveValue(localToday);
    await expect(page.getByLabel('Document name')).toBeEnabled();
    const duplicateResponse = await page.context().request.get(new URL(`/documents/${copyId}`, page.url()).toString());
    expect(duplicateResponse.status()).toBe(200);
    const duplicate = await duplicateResponse.json() as { status: string; issueDate: string; finalizedAt: string | null };
    expect(duplicate).toMatchObject({ status: 'draft', issueDate: localToday, finalizedAt: null });
    const unchangedSnapshot = await page.context().request.get(new URL(`/documents/${documentId}`, page.url()).toString());
    expect(await unchangedSnapshot.json()).toEqual(snapshot);
  } finally {
    await migrationPool.query('DELETE FROM users WHERE email_canonical = $1', [email.toLowerCase()]);
  }
});

test('duplicates a saved draft while source stays open and copy stays editable', async ({ page }) => {
  const email = `duplicate-ui-${randomUUID()}@example.com`;
  const password = 'A🔐b$cD';
  try {
    await page.goto('/');
    await page.getByRole('button', { name: 'Create account' }).click();
    await page.getByLabel('Email address').fill(email);
    await page.getByLabel('Password').fill(password);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('heading', { name: 'Documents', exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'New document' }).click();
    await expect(page.getByRole('button', { name: 'Duplicate' })).toHaveCount(0);
    const localToday = await page.evaluate(() => {
      const date = new Date();
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    });
    await page.getByLabel('Document name').fill('Duplicate source');
    await page.getByLabel('Customer name').fill('Original customer');
    await expect(page.getByLabel('Issue date')).toHaveValue(localToday);

    await page.getByRole('button', { name: 'Add line item' }).click();
    const firstLine = page.getByTestId('line-item').nth(0);
    await firstLine.getByLabel('Line description').fill('First line');
    await firstLine.getByLabel('Qty').fill('2');
    await firstLine.getByLabel('Unit price €').fill('12.50');
    await firstLine.getByLabel('Discount €').fill('1.00');
    await firstLine.getByLabel('Tax %').fill('19.00');
    await page.getByRole('button', { name: 'Add line item' }).click();
    const secondLine = page.getByTestId('line-item').nth(1);
    await secondLine.getByLabel('Line description').fill('Second line');
    await secondLine.getByLabel('Qty').fill('1');
    await secondLine.getByLabel('Unit price €').fill('8.00');
    await secondLine.getByLabel('Tax %').fill('7.50');

    await page.getByRole('button', { name: 'Save as draft' }).click();
    await expect(page.getByRole('heading', { name: 'Duplicate source' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Duplicate' })).toBeVisible();
    const sourceId = new URL(page.url()).hash.split('/').at(-1)!;
    const sourceUrl = page.url();
    const sourceResponse = await page.context().request.get(new URL(`/documents/${sourceId}`, page.url()).toString());
    expect(sourceResponse.status()).toBe(200);
    const sourceBefore = await sourceResponse.json() as {
      id: string; title: string; customerName: string; issueDate: string; status: string;
      finalizedAt: string | null; lineItems: Array<Record<string, unknown>>; amounts: Record<string, number>;
    };
    expect(sourceBefore.status).toBe('draft');

    await page.getByRole('button', { name: 'Duplicate' }).click();
    await expect(page).toHaveURL(sourceUrl);
    await expect(page.getByRole('heading', { name: 'Duplicate source' })).toBeVisible();
    await expect(page.getByRole('status')).toHaveText('Draft duplicated.');
    const openCopy = page.getByRole('link', { name: 'Open copy' });
    await expect(openCopy).toBeVisible();
    const href = await openCopy.getAttribute('href');
    expect(href).toMatch(/^#\/documents\/[0-9a-f-]+$/i);
    const copyId = decodeURIComponent(href!.split('/').at(-1)!);

    await openCopy.click();
    await expect(page).toHaveURL(new RegExp(`#\\/documents\\/${copyId}$`));
    await expect(page.getByRole('heading', { name: 'Duplicate source' })).toBeVisible();
    await expect(page.getByLabel('Issue date')).toHaveValue(localToday);
    await expect(page.getByLabel('Document name')).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Save changes' })).toBeVisible();

    const copyResponse = await page.context().request.get(new URL(`/documents/${copyId}`, page.url()).toString());
    expect(copyResponse.status()).toBe(200);
    const copy = await copyResponse.json() as typeof sourceBefore;
    expect(copy).toMatchObject({
      title: sourceBefore.title,
      customerName: sourceBefore.customerName,
      issueDate: localToday,
      status: 'draft',
      finalizedAt: null,
    });
    expect(copy.id).not.toBe(sourceBefore.id);
    expect(copy.lineItems.map(line => line.id)).not.toEqual(sourceBefore.lineItems.map(line => line.id));
    const copiedInputs = (items: Array<Record<string, unknown>>): Array<Record<string, unknown>> => items.map(item => {
      const input = { ...item };
      delete input.id;
      return input;
    });
    expect(copiedInputs(copy.lineItems)).toEqual(copiedInputs(sourceBefore.lineItems));
    const sourceAfter = await page.context().request.get(new URL(`/documents/${sourceId}`, page.url()).toString());
    expect(await sourceAfter.json()).toEqual(sourceBefore);

    await page.getByLabel('Customer name').fill('Edited copy customer');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByRole('status')).toHaveText('Draft saved.');
    const editedCopyResponse = await page.context().request.get(new URL(`/documents/${copyId}`, page.url()).toString());
    expect(await editedCopyResponse.json()).toMatchObject({ status: 'draft', customerName: 'Edited copy customer' });
    await test.info().attach('issue-18-duplicated-document.json', {
      body: JSON.stringify({ source: sourceBefore, copy }, null, 2), contentType: 'application/json',
    });
  } finally {
    await migrationPool.query('DELETE FROM users WHERE email_canonical = $1', [email.toLowerCase()]);
  }
});

test('adds priced line items, previews exact arithmetic, and reloads server totals', async ({ page }) => {
  const email = `line-pricing-${randomUUID()}@example.com`;
  const password = 'A🔐b$cD';
  try {
    await page.goto('/');
    await page.getByRole('button', { name: 'Create account' }).click();
    await page.getByLabel('Email address').fill(email);
    await page.getByLabel('Password').fill(password);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('heading', { name: 'Documents', exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'New document' }).click();
    await page.getByLabel('Document name').fill('Brand workshop');
    await page.getByRole('button', { name: 'Add line item' }).click();
    const firstLine = page.getByTestId('line-item').nth(0);
    await firstLine.getByLabel('Line description').fill('Brand workshop');
    await firstLine.getByLabel('Qty').fill('3');
    await firstLine.getByLabel('Unit price €').fill('19.99');
    await firstLine.getByLabel('Discount €').fill('10.00');
    await firstLine.getByLabel('Tax %').fill('19.00');
    await page.getByRole('button', { name: 'Add line item' }).click();
    const secondLine = page.getByTestId('line-item').nth(1);
    await secondLine.getByLabel('Line description').fill('Print-ready files');
    await secondLine.getByLabel('Qty').fill('2');
    await secondLine.getByLabel('Unit price €').fill('2.50');
    await secondLine.getByLabel('Tax %').fill('7.50');

    await expect(firstLine.locator('.line-math')).toContainText(/59\.97.*10\.00.*49\.97.*9\.49/);
    await expect(firstLine.locator('.line-sum')).toContainText('59.46');
    await expect(secondLine.locator('.line-math')).toContainText(/5\.00.*0\.00.*5\.00.*0\.38/);
    await expect(secondLine.locator('.line-sum')).toContainText('5.38');
    await expect(page.locator('.amount-list')).toContainText('64.97');
    await expect(page.locator('.amount-list')).toContainText('10.00');
    await expect(page.locator('.amount-list')).toContainText('54.97');
    await expect(page.locator('.amount-list')).toContainText('9.87');
    await expect(page.locator('.grand-total')).toContainText('64.84');

    await page.getByRole('button', { name: 'Save as draft' }).click();
    await expect(page).toHaveURL(/#\/documents\/[0-9a-f-]+$/i);
    const documentId = new URL(page.url()).hash.split('/').at(-1)!;
    await expect(page.getByTestId('line-item')).toHaveCount(2);
    await expect(page.locator('.grand-total')).toContainText('64.84');
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Brand workshop' })).toBeVisible();
    await expect(page.getByTestId('line-item')).toHaveCount(2);
    await expect(page.getByLabel('Line description').nth(0)).toHaveValue('Brand workshop');
    await expect(page.getByLabel('Unit price €').nth(1)).toHaveValue('2.50');
    await expect(page.locator('.grand-total')).toContainText('64.84');

    const response = await page.context().request.get(new URL(`/documents/${documentId}`, page.url()).toString());
    expect(response.status()).toBe(200);
    const persisted = await response.json() as {
      lineItems: Array<{ quantity: number; unitPriceCents: number; discountCents: number; taxRateBasisPoints: number; amounts: Record<string, number> }>;
      amounts: Record<string, number>;
    };
    expect(persisted.lineItems.map(line => ({
      quantity: line.quantity,
      unitPriceCents: line.unitPriceCents,
      discountCents: line.discountCents,
      taxRateBasisPoints: line.taxRateBasisPoints,
      amounts: line.amounts,
    }))).toEqual([
      {
        quantity: 3, unitPriceCents: 1999, discountCents: 1000, taxRateBasisPoints: 1900,
        amounts: { subtotalCents: 5997, discountCents: 1000, taxableCents: 4997, taxCents: 949, totalCents: 5946 },
      },
      {
        quantity: 2, unitPriceCents: 250, discountCents: 0, taxRateBasisPoints: 750,
        amounts: { subtotalCents: 500, discountCents: 0, taxableCents: 500, taxCents: 38, totalCents: 538 },
      },
    ]);
    expect(persisted.amounts).toEqual({
      subtotalCents: 6497, discountCents: 1000, taxableCents: 5497, taxCents: 987, totalCents: 6484,
    });
    await test.info().attach('issue-15-authoritative-document.json', {
      body: JSON.stringify(persisted, null, 2), contentType: 'application/json',
    });
    await page.screenshot({ fullPage: true }).then(body => test.info().attach('issue-15-ledger-editor-desktop.png', { body, contentType: 'image/png' }));
    await page.setViewportSize({ width: 390, height: 844 });
    const mobileWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(mobileWidth).toBeLessThanOrEqual(390);
    await page.screenshot({ fullPage: true }).then(body => test.info().attach('issue-15-ledger-editor-mobile.png', { body, contentType: 'image/png' }));
  } finally {
    await migrationPool.query('DELETE FROM users WHERE email_canonical = $1', [email.toLowerCase()]);
  }
});

test('keeps invalid unfinished line visible and blocks draft save', async ({ page }) => {
  const email = `unfinished-line-${randomUUID()}@example.com`;
  const password = 'A🔐b$cD';
  try {
    await page.goto('/');
    await page.getByRole('button', { name: 'Create account' }).click();
    await page.getByLabel('Email address').fill(email);
    await page.getByLabel('Password').fill(password);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('heading', { name: 'Documents', exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'New document' }).click();
    await page.getByLabel('Document name').fill('Unfinished pricing');
    await page.getByRole('button', { name: 'Add line item' }).click();
    const line = page.getByTestId('line-item').nth(0);
    await line.getByLabel('Line description').fill('Retained input');
    await line.getByLabel('Unit price €').fill('1.239');
    await page.getByRole('button', { name: 'Save as draft' }).click();

    await expect(page.getByText('Check line item fields before saving.')).toBeVisible();
    await expect(page.getByText('Enter a EUR amount with up to two decimals.')).toBeVisible();
    await expect(line.getByLabel('Line description')).toHaveValue('Retained input');
    await expect(line.getByLabel('Unit price €')).toHaveValue('1.239');
    await expect(page).toHaveURL(/#\/documents\/new$/);
    const response = await page.context().request.get(new URL('/documents', page.url()).toString());
    const list = await response.json() as { items: Array<{ title: string }> };
    expect(list.items.some(item => item.title === 'Unfinished pricing')).toBe(false);
  } finally {
    await migrationPool.query('DELETE FROM users WHERE email_canonical = $1', [email.toLowerCase()]);
  }
});

test('restores unsaved editor input after session expiry and sign-in', async ({ page }) => {
  const email = `resume-${randomUUID()}@example.com`;
  const password = 'A🔐b$cD';
  try {
    await page.goto('/');
    await page.getByRole('button', { name: 'Create account' }).click();
    await page.getByLabel('Email address').fill(email);
    await page.getByLabel('Password').fill(password);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('heading', { name: 'Documents', exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'New document' }).click();
    await page.getByLabel('Document name').fill('Unsaved workshop');
    await page.getByLabel('Customer name').fill('Recovered studio');

    const cookie = (await page.context().cookies()).find(value => value.name === '__Host-session');
    expect(cookie).toBeDefined();
    const tokenHash = createHash('sha256').update(cookie!.value).digest('hex');
    await migrationPool.query(
      "UPDATE sessions SET expires_at = created_at + interval '1 millisecond' WHERE token_hash = $1",
      [tokenHash],
    );

    await page.reload();
    await expect(page.getByRole('heading', { name: 'Sign in to your workspace' })).toBeVisible();
    await page.getByLabel('Email address').fill(email);
    await page.getByLabel('Password').fill(password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('heading', { name: 'Unsaved workshop' })).toBeVisible();
    await expect(page.getByLabel('Customer name')).toHaveValue('Recovered studio');
    await expect(page.getByRole('button', { name: 'Save as draft' })).toBeVisible();
  } finally {
    await migrationPool.query('DELETE FROM users WHERE email_canonical = $1', [email.toLowerCase()]);
  }
});

test('edits, moves, and removes saved line items with visible controls', async ({ page }) => {
  const email = `line-mutations-${randomUUID()}@example.com`;
  const password = 'A🔐b$cD';
  try {
    await page.goto('/');
    await page.getByRole('button', { name: 'Create account' }).click();
    await page.getByLabel('Email address').fill(email);
    await page.getByLabel('Password').fill(password);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('heading', { name: 'Documents', exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'New document' }).click();
    await page.getByLabel('Document name').fill('Line mutation draft');
    for (const [index, description] of ['Alpha', 'Bravo', 'Charlie'].entries()) {
      await page.getByRole('button', { name: 'Add line item' }).click();
      const line = page.getByTestId('line-item').nth(index);
      await line.getByLabel('Line description').fill(description);
      await line.getByLabel('Unit price €').fill(`${(index + 1) * 10}.00`);
    }
    await page.getByRole('button', { name: 'Save as draft' }).click();
    await expect(page).toHaveURL(/#\/documents\/[0-9a-f-]+$/i);
    const documentId = new URL(page.url()).hash.split('/').at(-1)!;
    await expect(page.getByTestId('line-item')).toHaveCount(3);

    const detailUrl = new URL(`/documents/${documentId}`, page.url()).toString();
    const initialResponse = await page.context().request.get(detailUrl);
    expect(initialResponse.status()).toBe(200);
    const initial = await initialResponse.json() as {
      lineItems: Array<{ id: string; description: string; position: number; unitPriceCents: number }>;
    };
    const ids = Object.fromEntries(initial.lineItems.map(line => [line.description, line.id]));

    const bravo = page.getByTestId('line-item').nth(1);
    await bravo.getByLabel('Unit price €').fill('1.239');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(bravo.getByLabel('Unit price €')).toHaveValue('1.239');
    await expect(bravo.getByText('Enter a EUR amount with up to two decimals.')).toBeVisible();
    await page.reload();
    const recoveredBravo = page.getByTestId('line-item').nth(1);
    await expect(recoveredBravo.getByLabel('Unit price €')).toHaveValue('1.239');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(recoveredBravo.getByText('Enter a EUR amount with up to two decimals.')).toBeVisible();
    const afterInvalidResponse = await page.context().request.get(detailUrl);
    const afterInvalid = await afterInvalidResponse.json() as typeof initial;
    expect(afterInvalid.lineItems.map(line => [line.id, line.unitPriceCents])).toEqual([
      [ids.Alpha, 1000], [ids.Bravo, 2000], [ids.Charlie, 3000],
    ]);

    await recoveredBravo.getByLabel('Unit price €').fill('21.99');
    await page.getByRole('button', { name: 'Move line 2 up' }).click();
    await expect(page.getByTestId('line-item').nth(0).getByLabel('Line description')).toHaveValue('Bravo');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByRole('status')).toHaveText('Draft saved.');
    await page.reload();
    await expect(page.getByTestId('line-item').nth(0).getByLabel('Line description')).toHaveValue('Bravo');

    const movedResponse = await page.context().request.get(detailUrl);
    expect(movedResponse.status()).toBe(200);
    const moved = await movedResponse.json() as typeof initial;
    expect(moved.lineItems.map(line => [line.id, line.position, line.description, line.unitPriceCents])).toEqual([
      [ids.Bravo, 1, 'Bravo', 2199], [ids.Alpha, 2, 'Alpha', 1000], [ids.Charlie, 3, 'Charlie', 3000],
    ]);
    await test.info().attach('issue-16-after-move.json', {
      body: JSON.stringify(moved, null, 2), contentType: 'application/json',
    });

    await page.getByRole('button', { name: 'Remove line 2' }).click();
    await expect(page.getByTestId('line-item')).toHaveCount(2);
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByRole('status')).toHaveText('Draft saved.');
    await page.reload();
    await expect(page.getByTestId('line-item')).toHaveCount(2);
    const finalResponse = await page.context().request.get(detailUrl);
    expect(finalResponse.status()).toBe(200);
    const persisted = await finalResponse.json() as typeof initial;
    expect(persisted.lineItems.map(line => [line.id, line.position, line.description])).toEqual([
      [ids.Bravo, 1, 'Bravo'], [ids.Charlie, 2, 'Charlie'],
    ]);
    await test.info().attach('issue-16-persisted-document.json', {
      body: JSON.stringify(persisted, null, 2), contentType: 'application/json',
    });
    await page.screenshot({ fullPage: true }).then(body => test.info().attach('issue-16-editor-desktop.png', { body, contentType: 'image/png' }));
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await page.screenshot({ fullPage: true }).then(body => test.info().attach('issue-16-editor-mobile.png', { body, contentType: 'image/png' }));
  } finally {
    await migrationPool.query('DELETE FROM users WHERE email_canonical = $1', [email.toLowerCase()]);
  }
});

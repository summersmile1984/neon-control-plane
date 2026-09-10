import { expect, test } from '@playwright/test';
import { OWNER_EMAIL } from './env';
import { loginWithPassword, preflight } from './support';

/** Console API-key and membership panels (design 004). */

test.beforeEach(async ({ request }) => {
  const reason = await preflight(request);
  test.skip(Boolean(reason), reason ?? '');
});

test('creates a personal key, shows the token once, then revokes it', async ({ page }) => {
  await page.goto('/console');
  await loginWithPassword(page);

  const name = `browser-key-${Date.now().toString(36)}`;
  await page.locator('#newKeyName').fill(name);
  await page.locator('#createKey').click();

  const secret = page.locator('#keys .secret textarea');
  await expect(secret).toBeVisible();
  const token = await secret.inputValue();
  expect(token).toMatch(/^napi_/);

  const row = page.locator('#keys .keyrow', { hasText: name });
  await expect(row).toBeVisible();
  await expect(row).not.toContainText(token);

  page.on('dialog', (dialog) => dialog.accept());
  await row.getByRole('button', { name: '撤销' }).click();
  await expect(page.locator('#keys .keyrow', { hasText: name })).toHaveCount(0);
});

test('lists the organization members', async ({ page }) => {
  await page.goto('/console');
  await loginWithPassword(page);

  await expect(page.locator('#orgLabel')).not.toBeEmpty();
  await expect(page.locator('#members')).toContainText(OWNER_EMAIL);
  await expect(page.locator('#members')).toContainText('admin');
});

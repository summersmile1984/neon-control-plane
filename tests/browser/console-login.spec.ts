import { expect, test } from '@playwright/test';
import { BOOTSTRAP_KEY, OWNER_EMAIL } from './env';
import { loginWithPassword, preflight } from './support';

/** Console login gate and session behavior (design 004). */

test.beforeEach(async ({ request }) => {
  const reason = await preflight(request);
  test.skip(Boolean(reason), reason ?? '');
});

test('serves the shell publicly and shows the login gate', async ({ page }) => {
  await page.goto('/console');
  await expect(page.locator('h1')).toContainText('Neon 本地控制面');
  await expect(page.locator('#login')).toHaveClass(/show/);
});

test('rejects a wrong password and stays gated', async ({ page }) => {
  await page.goto('/console');
  await expect(page.locator('#login')).toHaveClass(/show/);
  await page.locator('#loginEmail').fill(OWNER_EMAIL);
  await page.locator('#loginPassword').fill('definitely-wrong');
  await page.locator('#loginSubmit').click();
  await expect(page.locator('#loginError')).toContainText('incorrect');
  await expect(page.locator('#login')).toHaveClass(/show/);
});

test('signs in with email + password and loads the console', async ({ page }) => {
  await page.goto('/console');
  await loginWithPassword(page);
  await expect(page.locator('#tiles .tile').first()).toBeVisible();
});

test('signs in with the one-click dev login', async ({ page }) => {
  await page.goto('/console');
  await expect(page.locator('#devLogin')).toBeVisible();
  await page.locator('#devLogin').click();
  await expect(page.locator('#login')).not.toHaveClass(/show/);
  await expect(page.locator('#who')).not.toBeEmpty();
});

test('keeps the session across a reload and clears it on logout', async ({ page }) => {
  await page.goto('/console');
  await loginWithPassword(page);

  await page.reload();
  await expect(page.locator('#login')).not.toHaveClass(/show/);
  await expect(page.locator('#who')).toHaveText(OWNER_EMAIL);

  await page.request.post('/console/logout');
  await page.reload();
  await expect(page.locator('#login')).toHaveClass(/show/);
});

test('authenticates with a pasted API key instead of a session', async ({ page }) => {
  await page.goto('/console');
  await page.locator('#key').fill(BOOTSTRAP_KEY);
  await page.locator('#key').dispatchEvent('change');
  await expect(page.locator('#login')).not.toHaveClass(/show/);
  await expect(page.locator('#tiles .tile').first()).toBeVisible();
});

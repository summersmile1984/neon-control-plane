import { expect, test } from '@playwright/test';
import { expectLoggedInAsOidc, preflight } from './support';

/** Full OIDC redirect flow against the fake provider started by playwright.config.ts. */

test.beforeEach(async ({ request }) => {
  const reason = await preflight(request);
  test.skip(Boolean(reason), reason ?? '');
});

test('signs in through the OIDC provider', async ({ page }) => {
  await page.goto('/console');
  const oidcLink = page.locator('#oidcLogin');
  await expect(oidcLink).toBeVisible();

  await oidcLink.click();
  await expectLoggedInAsOidc(page);
});

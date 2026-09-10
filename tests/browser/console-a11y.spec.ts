import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { loginWithPassword, preflight } from './support';

/** Accessibility smoke test on the logged-in console (design 004). */

test.beforeEach(async ({ request }) => {
  const reason = await preflight(request);
  test.skip(Boolean(reason), reason ?? '');
});

test('the console has no serious or critical accessibility violations', async ({ page }) => {
  await page.goto('/console');
  await loginWithPassword(page);
  await expect(page.locator('#tiles .tile').first()).toBeVisible();

  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  const serious = results.violations.filter((violation) => violation.impact === 'serious' || violation.impact === 'critical');
  expect(serious, JSON.stringify(serious.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length })), null, 2)).toEqual([]);
});

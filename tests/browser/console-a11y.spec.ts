import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { authHeaders, loginWithPassword, preflight, storageReady } from './support';

/**
 * Accessibility smoke test on the logged-in console (design 004).
 *
 * It runs against a *populated* console on purpose. An empty control plane has nothing to scroll,
 * so the obvious defect here — an operation stream that scrolls on its own and cannot be reached
 * with the keyboard — only shows up once there are enough operations to overflow. Seeding is
 * skipped when the storage layer is down, and then the assertion runs against whatever is there.
 */

const BRANCHES = 24;

test.beforeEach(async ({ request }) => {
  const reason = await preflight(request);
  test.skip(Boolean(reason), reason ?? '');
});

test('the console has no serious or critical accessibility violations', async ({ page, request }) => {
  if (await storageReady(request)) {
    const created = await request.post('/api/v2/projects', {
      headers: authHeaders,
      data: { project: { name: `a11y-${Date.now()}`, pg_version: 17 } },
    });
    expect(created.status(), await created.text()).toBe(201);
    const { project } = await created.json() as { project: { id: string } };
    for (let index = 0; index < BRANCHES; index += 1) {
      await request.post(`/api/v2/projects/${project.id}/branches`, {
        headers: authHeaders,
        data: { branch: { name: `b${index}` } },
      });
    }
  }

  await page.goto('/console');
  await loginWithPassword(page);
  await expect(page.locator('#tiles .tile').first()).toBeVisible();
  // Wait for the operation stream to actually overflow its own card, otherwise this test would
  // pass on an empty console forever.
  await expect
    .poll(() => page.locator('#operations').evaluate((node) => (node as HTMLElement).scrollHeight > (node as HTMLElement).clientHeight + 1))
    .toBe(true);

  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  const serious = results.violations.filter((violation) => violation.impact === 'serious' || violation.impact === 'critical');
  expect(serious, JSON.stringify(serious.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length })), null, 2)).toEqual([]);
});

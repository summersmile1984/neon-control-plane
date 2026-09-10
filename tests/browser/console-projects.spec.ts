import { expect, test } from '@playwright/test';
import { loginWithPassword, PAGESERVER_URL, preflight, projectInternals, psql, storageReady } from './support';

/**
 * Project lifecycle through the console UI, plus the final-effect check on the data plane. The
 * console uses the real control plane in `direct` mode, so the URI it hands out is usable by psql
 * on the host: this proves a console-created project is a working Postgres, not just UI state.
 */

test.beforeEach(async ({ request }) => {
  const reason = await preflight(request);
  test.skip(Boolean(reason), reason ?? '');
  if (!(await storageReady(request))) test.skip(true, 'storage layer down; run pnpm compose:up');
});

test('creates a project, drives its endpoint, and runs DDL/DML on the real compute', async ({ page, request }) => {
  test.setTimeout(240_000);
  await page.goto('/console');
  await loginWithPassword(page);

  const name = `browser-${Date.now().toString(36)}`;
  await page.locator('#newName').fill(name);
  await page.locator('#create').click();

  const card = page.locator('#projects .card', { hasText: name });
  await expect(card).toBeVisible({ timeout: 30_000 });

  // The compute comes up asynchronously; refresh pushes it forward.
  await expect(async () => {
    await page.locator('#refresh').click();
    await expect(card.getByText('active')).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 90_000 });

  await card.getByRole('button', { name: '挂起' }).click();
  await expect(async () => {
    await page.locator('#refresh').click();
    await expect(card.getByText('idle')).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 60_000 });

  await card.getByRole('button', { name: '启动' }).click();
  await expect(async () => {
    await page.locator('#refresh').click();
    await expect(card.getByText('active')).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 60_000 });

  // The URI the console hands out is the one we will actually connect with.
  await card.getByRole('button', { name: '取连接串' }).click();
  const uriField = card.locator('.secret textarea');
  await expect(uriField).toHaveValue(/^postgresql:\/\//);
  const uri = await uriField.inputValue();

  // Final effect 1: the project is a real pageserver tenant with a timeline.
  const internals = await projectInternals(request, name);
  expect(internals, 'console snapshot did not expose tenant/timeline').toBeDefined();
  const tenants = (await (await request.get(`${PAGESERVER_URL}/v1/tenant`)).json()) as Array<{ id: string }>;
  expect(tenants.map((row) => row.id)).toContain(internals!.tenantId);
  const timelines = (await (await request.get(`${PAGESERVER_URL}/v1/tenant/${internals!.tenantId}/timeline`)).json()) as Array<{ timeline_id: string }>;
  expect(timelines.map((row) => row.timeline_id)).toContain(internals!.timelineId);

  // Final effect 2: the database exists and answers SQL on the compute.
  expect(psql(uri, 'select 1')).toBe('1');
  expect(psql(uri, "select datname from pg_database where datname = 'neondb'")).toBe('neondb');

  // Final effect 3: DDL and DML really execute through the connection the console issued.
  expect(psql(uri, 'drop table if exists console_probe')).toContain('DROP');
  expect(psql(uri, 'create table console_probe (id int primary key, note text)')).toBe('CREATE TABLE');
  expect(psql(uri, "insert into console_probe values (1, 'from-console')")).toBe('INSERT 0 1');
  expect(psql(uri, 'select note from console_probe where id = 1')).toBe('from-console');
  expect(psql(uri, "update console_probe set note = 'updated' where id = 1")).toBe('UPDATE 1');
  expect(psql(uri, 'select note from console_probe where id = 1')).toBe('updated');
  expect(psql(uri, 'delete from console_probe where id = 1')).toBe('DELETE 1');
  expect(psql(uri, 'select count(*) from console_probe')).toBe('0');

  page.on('dialog', (dialog) => dialog.accept());
  await card.getByRole('button', { name: '删项目' }).click();
  // Teardown is an asynchronous operation; the UI acknowledges the submission immediately.
  await expect(page.locator('#toast')).toContainText('删除已提交');
});

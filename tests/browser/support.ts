import { execFileSync } from 'node:child_process';
import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { BASE_URL, BOOTSTRAP_KEY, OIDC_EMAIL, OWNER_EMAIL, OWNER_PASSWORD } from './env';

/**
 * Helpers for the console browser suite. The control plane is the real `pnpm dev` process, so a
 * missing precondition is reported as a skip reason, never a red failure.
 */

export const authHeaders = { authorization: `Bearer ${BOOTSTRAP_KEY}` };
export const PAGESERVER_URL = process.env.CP_PAGESERVER_URL ?? 'http://127.0.0.1:9898';

/** Runs psql on the host against a full connection URI (direct mode publishes the compute port). */
export function psql(uri: string, sql: string): string {
  try {
    return execFileSync('psql', [uri, '-tAc', sql], { encoding: 'utf8' }).trim();
  } catch (error) {
    const detail = (error as { stderr?: Buffer | string }).stderr;
    return `ERROR: ${String(detail ?? (error as Error).message).trim().slice(0, 300)}`;
  }
}

/** The console snapshot carries the internal ids the data plane needs (tenant and timeline). */
export async function projectInternals(
  request: APIRequestContext,
  name: string,
): Promise<{ tenantId: string; timelineId: string } | undefined> {
  const response = await request.get('/console/state', { headers: authHeaders });
  if (!response.ok()) return undefined;
  const body = (await response.json()) as {
    projects?: Array<{ name: string; tenant_id: string; branches: Array<{ timeline_id: string }> }>;
  };
  const project = body.projects?.find((row) => row.name === name);
  const timeline = project?.branches[0];
  if (!project || !timeline) return undefined;
  return { tenantId: project.tenant_id, timelineId: timeline.timeline_id };
}


/** Returns a skip reason when the real control plane is unreachable or the bootstrap key is wrong. */
export async function preflight(request: APIRequestContext): Promise<string | undefined> {
  try {
    const health = await request.get(`${BASE_URL}/healthz`);
    if (!health.ok()) return `control plane healthz returned ${health.status()}`;
  } catch (error) {
    return `control plane not reachable at ${BASE_URL}: ${String(error).slice(0, 120)}`;
  }
  const me = await request.get('/api/v2/users/me', { headers: authHeaders });
  if (me.status() === 401) {
    return `bootstrap key rejected; start the control plane with CP_BOOTSTRAP_API_KEY=${BOOTSTRAP_KEY}`;
  }
  if (!me.ok()) return `authenticated probe returned ${me.status()}`;
  return undefined;
}

/** True when the storage layer (compose pageserver) answers, so project operations can be exercised. */
export async function storageReady(request: APIRequestContext): Promise<boolean> {
  const state = await request.get('/console/state', { headers: authHeaders });
  if (!state.ok()) return false;
  const body = (await state.json()) as { health?: { pageserver?: { ok?: boolean } } };
  return body.health?.pageserver?.ok === true;
}

/** Fills the password form and waits for the gate to close. */
export async function loginWithPassword(page: Page): Promise<void> {
  await expect(page.locator('#login')).toHaveClass(/show/);
  await page.locator('#loginEmail').fill(OWNER_EMAIL);
  await page.locator('#loginPassword').fill(OWNER_PASSWORD);
  await page.locator('#loginSubmit').click();
  await expect(page.locator('#login')).not.toHaveClass(/show/);
  await expect(page.locator('#who')).toHaveText(OWNER_EMAIL);
}

export async function expectLoggedInAsOidc(page: Page): Promise<void> {
  await expect(page.locator('#login')).not.toHaveClass(/show/);
  await expect(page.locator('#who')).toHaveText(OIDC_EMAIL);
}

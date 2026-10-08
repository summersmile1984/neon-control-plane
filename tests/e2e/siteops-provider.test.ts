import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * T-110: the real SiteOps client, unmodified, against a running control plane over HTTPS.
 *
 * This is the acceptance test the repository exists for. The SiteOps Neon provider refuses a
 * non-HTTPS base URL, so the request path here is exactly the deployed one:
 *
 *   provider-neon  ->  https://neon-api.siteops.localhost:8443  ->  Caddy  ->  control plane :8080
 *
 * Preconditions (skipped, not failed, when missing):
 *   - a SiteOps checkout; defaults to a `site-growth/siteops-platform` directory next to this
 *     repository, override with SITEOPS_PLATFORM_DIR when it lives elsewhere
 *   - `pnpm compose:up` and `pnpm dev` in this repo, with CP_ROUTE_MODE=proxy
 *   - SiteOps Caddy running with the `neon-api.siteops.localhost` block (T-202)
 *
 * The client drops any response that fails its own validators, so every assertion below is on the
 * mapped value, never on the HTTP status.
 */

const SITEOPS_PLATFORM_DIR =
  process.env.SITEOPS_PLATFORM_DIR ?? fileURLToPath(new URL('../../../site-growth/siteops-platform', import.meta.url));
const SITEOPS_CLIENT = join(SITEOPS_PLATFORM_DIR, 'packages/provider-neon/src/index.ts');
const BASE_URL = process.env.CP_PUBLIC_BASE_URL ?? 'https://neon-api.siteops.localhost:8443/api/v2';
const CONNECTION_ZONE = process.env.CP_ZONE ?? 'db.siteops.localhost';
const API_KEY = process.env.CP_API_KEY ?? '';
const ORG_ID = process.env.CP_ORG_ID;

interface ProviderResultLike<T> { status: string; value?: T }
interface ManagementClient {
  createBranch(context: unknown, input: unknown): Promise<ProviderResultLike<{ ref: { providerResourceRef: string }; name?: string; state?: string }>>;
  observeBranch(context: unknown, branchRef: string): Promise<ProviderResultLike<{ ref: { providerResourceRef: string }; state?: string }>>;
  listBranchEndpoints(context: unknown, branchRef: string): Promise<ProviderResultLike<{ endpoints: Array<{ providerResourceRef: string; state?: string; host?: string }> }>>;
  createRole(context: unknown, input: unknown): Promise<ProviderResultLike<{ role: { name: string }; password: string }>>;
  revealRolePassword(context: unknown, branchRef: string, roleName: string): Promise<ProviderResultLike<{ password: string }>>;
  resetRolePassword(context: unknown, branchRef: string, roleName: string): Promise<ProviderResultLike<{ role: { name: string }; password: string }>>;
  createDatabase(context: unknown, input: unknown): Promise<ProviderResultLike<{ name?: string; ownerName?: string }>>;
  listBranchDatabases(context: unknown, branchRef: string): Promise<ProviderResultLike<{ databases: Array<{ name?: string }> }>>;
  listBranchRoles(context: unknown, branchRef: string): Promise<ProviderResultLike<{ roles: Array<{ name: string }> }>>;
  getConnectionUri(context: unknown, input: unknown): Promise<ProviderResultLike<{ uri: string }>>;
  deleteRole(context: unknown, branchRef: string, roleName: string): Promise<ProviderResultLike<null>>;
  deleteDatabase(context: unknown, branchRef: string, databaseName: string): Promise<ProviderResultLike<null>>;
  deleteBranch(context: unknown, branchRef: string): Promise<ProviderResultLike<null>>;
}

const origin = new URL(BASE_URL).origin;
const zonePattern = CONNECTION_ZONE.replace(/\./g, '\\.');
const URI_SHAPE = new RegExp(`^postgresql://siteops_role:[^@]+@ep-[a-z0-9-]+\\.${zonePattern}/siteops_db\\?sslmode=require&channel_binding=require$`);

let client: ManagementClient | undefined;
let projectId = '';
let branchRef = '';
let ready = false;
let skipReason = '';

const authHeader = { authorization: `Bearer ${API_KEY}` };

function context(): unknown {
  return {
    operationId: `op_${randomUUID().slice(0, 8)}`,
    idempotencyKey: randomUUID(),
    organizationId: 'org_local',
    workspaceId: 'ws_local',
    timeoutMs: 120_000,
    trace: { requestId: randomUUID() },
  };
}

async function api(path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...authHeader, ...(init.headers ?? {}) },
  });
  const text = await response.text();
  if (response.status >= 400) throw new Error(`${path} -> ${response.status} ${text.slice(0, 200)}`);
  return (text ? JSON.parse(text) : {}) as Record<string, unknown>;
}

/** Poll the public operations endpoint, exactly as a real consumer would. */
async function settle(timeoutMs = 180_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const body = await api(`/projects/${projectId}/operations`);
    const operations = body.operations as Array<{ status: string; action: string; error?: string }>;
    const failed = operations.filter((row) => row.status === 'failed');
    if (failed.length > 0) throw new Error(`operation failed: ${failed.map((row) => `${row.action}: ${row.error}`).join('; ')}`);
    if (!operations.some((row) => row.status === 'scheduling' || row.status === 'running')) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('operations did not settle');
}

function expectSucceeded<T>(result: ProviderResultLike<T>, what: string): T {
  expect(result.status, `${what}: ${JSON.stringify(result).slice(0, 300)}`).toBe('SUCCEEDED');
  expect(result.value, `${what} produced no mapped value; the response failed the consumer validators`).toBeDefined();
  return result.value as T;
}

beforeAll(async () => {
  if (!existsSync(SITEOPS_CLIENT)) {
    skipReason = `sibling checkout not found at ${SITEOPS_CLIENT}`;
    return;
  }
  if (!API_KEY) {
    skipReason = 'CP_API_KEY is not set; start the control plane with CP_BOOTSTRAP_API_KEY=<key> and export the same value as CP_API_KEY';
    return;
  }
  try {
    const health = await fetch(`${origin}/healthz`);
    if (!health.ok) throw new Error(String(health.status));
  } catch (error) {
    skipReason = `control plane not reachable at ${origin} (run pnpm dev and the SiteOps Caddy): ${String(error).slice(0, 120)}`;
    return;
  }
  try {
    const probe = await fetch(`${BASE_URL}/users/me`, { headers: { authorization: `Bearer ${API_KEY}` } });
    if (probe.status === 401) {
      skipReason = 'CP_API_KEY was rejected (401); seed it via CP_BOOTSTRAP_API_KEY or the console';
      return;
    }
    if (!probe.ok) throw new Error(String(probe.status));
  } catch (error) {
    skipReason = `authenticated probe failed at ${BASE_URL}: ${String(error).slice(0, 120)}`;
    return;
  }

  const query = ORG_ID ? `?org_id=${encodeURIComponent(ORG_ID)}` : '';
  const created = await api(`/projects${query}`, {
    method: 'POST',
    body: JSON.stringify({ project: { name: `siteops-e2e-${randomUUID().slice(0, 6)}`, pg_version: 17 } }),
  });
  projectId = (created.project as Record<string, unknown>).id as string;
  await settle();

  const module = (await import(SITEOPS_CLIENT)) as { NeonManagementApiClient: new (options: unknown) => ManagementClient };
  client = new module.NeonManagementApiClient({
    scope: { organizationId: 'org_local', projectId, workspaceId: 'ws_local' },
    // The provider resolves an opaque broker handle to the API key; locally the resolver is trivial.
    credentialHandle: 'neon_local_management_v1',
    credentials: { resolve: async () => API_KEY },
    baseUrl: BASE_URL,
    timeoutMs: 120_000,
    // The client defaults to the Neon Cloud host suffix; a self-hosted plane declares its own zone.
    connectionHostSuffixes: [`.${CONNECTION_ZONE}`],
  });
  ready = true;
}, 300_000);

afterAll(async () => {
  if (!ready || !projectId) return;
  await api(`/projects/${projectId}`, { method: 'DELETE' }).catch(() => undefined);
  await settle(120_000).catch(() => undefined);
}, 300_000);

beforeEach((context) => {
  if (!ready) context.skip(skipReason || 'control plane not ready');
});

describe('the real SiteOps provider-neon client over HTTPS', () => {
  it('is wired up against a running control plane', () => {
    if (!ready) return expect(ready, skipReason).toBe(false);
    expect(client).toBeDefined();
    expect(BASE_URL.startsWith('https://'), 'the client refuses a non-HTTPS base URL').toBe(true);
  });

  it('creates a branch with a read_write endpoint (database.create)', async () => {
    if (!ready) return;
    const branch = expectSucceeded(await client!.createBranch(context(), {
      name: 'siteops-preview',
      logicalResourceId: 'lr_siteops_1',
      createReadWriteEndpoint: true,
    }), 'createBranch');

    branchRef = branch.ref.providerResourceRef;
    expect(branchRef).toMatch(/^br-/);
    expect(branch.name).toBe('siteops-preview');
    await settle();

    const observed = expectSucceeded(await client!.observeBranch(context(), branchRef), 'observeBranch');
    expect(observed.ref.providerResourceRef).toBe(branchRef);

    const endpoints = expectSucceeded(await client!.listBranchEndpoints(context(), branchRef), 'listBranchEndpoints');
    expect(endpoints.endpoints).toHaveLength(1);
    expect(endpoints.endpoints[0]!.state).toBe('active');
    expect(endpoints.endpoints[0]!.host).toBeTruthy();
  }, 300_000);

  it('converges a site role and reveals its password (site_role.converge)', async () => {
    if (!ready) return;
    const created = expectSucceeded(await client!.createRole(context(), { branchRef, name: 'siteops_role' }), 'createRole');
    expect(created.role.name).toBe('siteops_role');
    expect(created.password.length).toBeGreaterThan(10);
    await settle();

    const revealed = expectSucceeded(await client!.revealRolePassword(context(), branchRef, 'siteops_role'), 'revealRolePassword');
    expect(revealed.password).toBe(created.password);

    const reset = expectSucceeded(await client!.resetRolePassword(context(), branchRef, 'siteops_role'), 'resetRolePassword');
    expect(reset.password).not.toBe(created.password);
    await settle();

    const roles = expectSucceeded(await client!.listBranchRoles(context(), branchRef), 'listBranchRoles');
    expect(roles.roles.map((row) => row.name)).toContain('siteops_role');
  }, 300_000);

  it('creates a database owned by that role (database.preview)', async () => {
    if (!ready) return;
    const database = expectSucceeded(await client!.createDatabase(context(), {
      logicalResourceId: 'lr_siteops_db', branchRef, name: 'siteops_db', ownerName: 'siteops_role',
    }), 'createDatabase');
    expect(database.name).toBe('siteops_db');
    await settle();

    const databases = expectSucceeded(await client!.listBranchDatabases(context(), branchRef), 'listBranchDatabases');
    expect(databases.databases.map((row) => row.name)).toContain('siteops_db');
  }, 300_000);

  it('hands back a connection URI in the shape the consumer parses (database.observe)', async () => {
    if (!ready) return;
    const endpoints = expectSucceeded(await client!.listBranchEndpoints(context(), branchRef), 'listBranchEndpoints');
    const uri = expectSucceeded(await client!.getConnectionUri(context(), {
      branchRef,
      endpointRef: endpoints.endpoints[0]!.providerResourceRef,
      databaseName: 'siteops_db',
      roleName: 'siteops_role',
      pooled: false,
    }), 'getConnectionUri');
    expect(uri.uri).toMatch(URI_SHAPE);
  }, 120_000);

  it('tears down in the provider order (site_role.delete then database.delete)', async () => {
    if (!ready) return;
    expect((await client!.deleteDatabase(context(), branchRef, 'siteops_db')).status).toBe('SUCCEEDED');
    await settle();
    expect((await client!.deleteRole(context(), branchRef, 'siteops_role')).status).toBe('SUCCEEDED');
    await settle();
    expect((await client!.deleteBranch(context(), branchRef)).status).toBe('SUCCEEDED');
    await settle();

    const branches = await api(`/projects/${projectId}/branches`);
    expect((branches.branches as Array<{ id: string }>).map((row) => row.id)).not.toContain(branchRef);
  }, 300_000);
});

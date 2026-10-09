import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { scramSha256 } from '../../src/domain/scram.ts';
import type { Hono } from 'hono';
import { openDatabase } from '../../src/store/db.ts';
import { createRepositories, type Repositories } from '../../src/store/repo.ts';
import { createService } from '../../src/service.ts';
import { createApp, type AppEnv } from '../../src/http/app.ts';
import { configureRespond } from '../../src/http/respond.ts';
import { createReconciler, type Reconciler } from '../../src/reconciler/loop.ts';
import { createComputeSigner } from '../../src/domain/compute-auth.ts';
import { nullLogger } from '../../src/logger.ts';
import type { Config } from '../../src/config.ts';
import { fakeAdapters, type FakeAdapters } from '../support/fakes.ts';
import { authed, bootstrapForTest, testIdentity } from '../support/identity.ts';

/**
 * T-301: the private API the Neon proxy calls. There is no published contract, so these assertions
 * are the contract — they mirror `proxy/src/control_plane/messages.rs`:
 *
 *   GetEndpointAccessControl { role_secret, allowed_ips, allowed_vpc_endpoint_ids,
 *                              block_public_connections, block_vpc_connections, project_id, account_id }
 *   WakeCompute              { address, aux { endpoint_id, project_id, branch_id, compute_id, cold_start_info } }
 */

const workdir = mkdtempSync(join(tmpdir(), 'neon-cp-cplane-'));
configureRespond({ validate: true });

const PROXY_TOKEN = 'proxy-secret-token';

let repos: Repositories;
let app: Hono<AppEnv>;
let reconciler: Reconciler;
let fakes: FakeAdapters;

function config(withToken: boolean): Config {
  return {
    port: 0, dbPath: ':memory:', masterKey: randomBytes(32),
    pageserverUrl: 'http://pageserver.invalid', pageserverConnstring: 'host=pageserver port=6400',
    safekeepers: ['safekeeper1:5454'], neonTag: 'test', computeImageRepo: 'docker.io/neondatabase',
    dockerSocket: '/var/run/docker.sock', dockerNetwork: 'neon-cp-test',
    computeVolumeRoot: join(workdir, 'computes'), portRange: [55500, 55520],
    routeMode: 'proxy', zone: 'db.neon.localhost',
    proxyToken: withToken ? PROXY_TOKEN : undefined,
    validateResponses: true,
    identity: testIdentity(),
  };
}

function build(withToken = true, withCatalog = false): void {
  const cfg = config(withToken);
  repos = createRepositories(openDatabase(':memory:'));
  bootstrapForTest(repos, cfg.identity);
  fakes = fakeAdapters();
  const service = createService({ repos, pageserver: fakes.pageserver, config: cfg, logger: nullLogger });
  reconciler = createReconciler({
    repos, pageserver: fakes.pageserver, docker: fakes.docker, compute: fakes.compute,
    signer: createComputeSigner('test'), config: cfg, logger: nullLogger,
  });
  app = authed(createApp({ repos, service, config: cfg, logger: nullLogger, reconciler, ...(withCatalog ? { compute: fakes.compute } : {}) }));
}

async function seed(): Promise<{ projectId: string; endpointId: string; branchId: string }> {
  const response = await app.request('/api/v2/projects', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project: { name: 'cplane' } }),
  });
  const body = (await response.json()) as Record<string, unknown>;
  return {
    projectId: (body.project as Record<string, unknown>).id as string,
    branchId: (body.branch as Record<string, unknown>).id as string,
    endpointId: ((body.endpoints as Array<Record<string, unknown>>)[0]!).id as string,
  };
}

const auth = { authorization: `Bearer ${PROXY_TOKEN}` };

beforeEach(() => build());
afterAll(() => rmSync(workdir, { recursive: true, force: true }));

describe('proxy control-plane API', () => {
  it('authenticates SQL-created roles from the signed catalog without adding them to the managed spec', async () => {
    build(true, true);
    const { endpointId, branchId } = await seed();
    const first = scramSha256('first-test-password');
    const second = scramSha256('second-test-password');
    const read = vi.spyOn(fakes.compute, 'dbsAndRoles').mockResolvedValue({
      databases: [], roles: [{ name: 'site_aabbcc11', encrypted_password: first }],
    });
    const url = `/cplane/get_endpoint_access_control?endpointish=${endpointId}&role=site_aabbcc11`;
    expect((await app.request(url)).status).toBe(401);
    expect(read).not.toHaveBeenCalled();
    const response = await app.request(url, { headers: auth });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ role_secret: first });
    expect(read).toHaveBeenCalledWith({ baseUrl: `http://127.0.0.1:${repos.endpoints.get(endpointId)!.http_port}`, computeId: endpointId });
    expect(repos.endpoints.get(endpointId)?.current_state).toBe('active');
    expect(repos.roles.get(branchId, 'site_aabbcc11')).toBeUndefined();
    expect(JSON.stringify(fakes.state.specs)).not.toContain('site_aabbcc11');
    // No CP verifier cache: a rotation or deletion must be observed on the next lookup.
    read.mockResolvedValue({ databases: [], roles: [{ name: 'site_aabbcc11', encrypted_password: second }] });
    expect(await (await app.request(url, { headers: auth })).json()).toMatchObject({ role_secret: second });
    read.mockResolvedValue({ databases: [], roles: [] });
    expect((await app.request(url, { headers: auth })).status).toBe(404);
  });

  it('never falls back to a stored verifier after a catalog failure, and redacts adapter errors', async () => {
    build(true, true);
    const { endpointId } = await seed();
    const sensitive = 'SCRAM-SHA-256$4096:private$private:private';
    vi.spyOn(fakes.compute, 'dbsAndRoles').mockRejectedValue(new Error(sensitive));
    const logs = vi.spyOn(nullLogger, 'error');
    try {
      const response = await app.request(`/cplane/get_endpoint_access_control?endpointish=${endpointId}&role=neondb_owner`, { headers: auth });
      expect(response.status).toBe(500);
      expect(await response.text()).not.toContain(sensitive);
      expect(JSON.stringify(logs.mock.calls)).not.toContain(sensitive);
    } finally { logs.mockRestore(); }
  });

  it('rejects disabled endpoints, reserved roles, and malformed catalog verifiers', async () => {
    build(true, true);
    const { endpointId } = await seed();
    const read = vi.spyOn(fakes.compute, 'dbsAndRoles').mockResolvedValue({
      databases: [], roles: [{ name: 'site_aabbcc11', encrypted_password: 'not-a-verifier' }],
    });
    for (const role of ['cloud_admin', 'pg_read_all_data']) {
      expect((await app.request(`/cplane/get_endpoint_access_control?endpointish=${endpointId}&role=${role}`, { headers: auth })).status).toBe(404);
    }
    expect(read).not.toHaveBeenCalled();
    const url = `/cplane/get_endpoint_access_control?endpointish=${endpointId}&role=site_aabbcc11`;
    expect((await app.request(url, { headers: auth })).status).toBe(404);
    read.mockClear();
    repos.endpoints.update(endpointId, { disabled: 1 });
    expect((await app.request(url, { headers: auth })).status).toBe(400);
    expect(read).not.toHaveBeenCalled();
  });

  it('returns the access-control shape the proxy deserialises', async () => {
    const { projectId, endpointId } = await seed();
    const response = await app.request(
      `/cplane/get_endpoint_access_control?session_id=s1&application_name=proxy&endpointish=${endpointId}&role=neondb_owner`,
      { headers: auth },
    );
    expect(response.status, await response.clone().text()).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;

    expect(Object.keys(body).sort()).toEqual([
      'account_id', 'allowed_ips', 'allowed_vpc_endpoint_ids',
      'block_public_connections', 'block_vpc_connections', 'project_id', 'role_secret',
    ]);
    // The proxy runs SCRAM itself, so it needs the verifier, never the plaintext.
    expect(String(body.role_secret)).toMatch(/^SCRAM-SHA-256\$4096:/);
    expect(body.project_id).toBe(projectId);
    expect(body.allowed_ips).toEqual([]);
    expect(body.block_public_connections).toBe(false);
  });

  it('accepts the -pooler suffix the proxy may pass through', async () => {
    const { endpointId } = await seed();
    const response = await app.request(
      `/cplane/get_endpoint_access_control?endpointish=${endpointId}-pooler&role=neondb_owner`, { headers: auth },
    );
    expect(response.status).toBe(200);
  });

  it('404s an unknown endpoint or role', async () => {
    const { endpointId } = await seed();
    expect((await app.request('/cplane/get_endpoint_access_control?endpointish=ep-nope&role=neondb_owner', { headers: auth })).status).toBe(404);
    expect((await app.request(`/cplane/get_endpoint_access_control?endpointish=${endpointId}&role=ghost`, { headers: auth })).status).toBe(404);
  });

  /**
   * The proxy deserialises failures as `ControlPlaneErrorMessage { error, http_status_code, status }`.
   * Handing it the v2 `GeneralError { code, message }` instead makes it log
   * "failed to parse error body: missing field `error`" and tell the client "reason unclear",
   * which hides every real cause. Measured against proxy build 8464.
   */
  it('fails in the error envelope the proxy deserialises, on every path under /cplane', async () => {
    await seed();
    const cases = [
      '/cplane/get_endpoint_access_control?endpointish=ep-nope&role=neondb_owner', // handler error
      '/cplane/wake_compute', // missing query parameter
      '/cplane/no_such_method', // notFound
    ];
    for (const path of cases) {
      const response = await app.request(path, { headers: auth });
      const body = (await response.json()) as Record<string, unknown>;
      expect(typeof body.error, `${path} -> ${JSON.stringify(body)}`).toBe('string');
      expect(body.http_status_code).toBe(response.status);
      expect(body.code).toBeUndefined();
    }
    // An unauthenticated call fails inside the handler too, so it must use the same envelope.
    const denied = await app.request('/cplane/wake_compute?endpointish=ep-nope');
    expect(denied.status).toBe(401);
    expect(typeof ((await denied.json()) as Record<string, unknown>).error).toBe('string');
  });

  /**
   * `--auth-endpoint` ending in a slash yields `/cplane//wake_compute`, because the proxy joins the
   * method name on with its own separator. The compose file omits the trailing slash; this alias
   * means a stray one degrades to a working request rather than an opaque 404.
   */
  it('answers the doubled-slash path an auth-endpoint trailing slash produces', async () => {
    const { endpointId } = await seed();
    await reconciler.drain();
    const response = await app.request(`/cplane//wake_compute?endpointish=${endpointId}`, { headers: auth });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(((await response.json()) as { aux: Record<string, unknown> }).aux.endpoint_id).toBe(endpointId);
  });

  it('returns the wake_compute shape and marks a warm compute warm', async () => {
    const { projectId, branchId, endpointId } = await seed();
    await reconciler.drain();

    const response = await app.request(`/cplane/wake_compute?session_id=s1&endpointish=${endpointId}`, { headers: auth });
    expect(response.status, await response.clone().text()).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;

    expect(Object.keys(body).sort()).toEqual(['address', 'aux']);
    expect(String(body.address)).toMatch(/^ep-[a-z0-9-]+:55433$/);
    expect(body.aux).toEqual({
      endpoint_id: endpointId,
      project_id: projectId,
      branch_id: branchId,
      compute_id: endpointId,
      cold_start_info: 'warm',
    });
  });

  /**
   * `cold_start_info` is deserialised into the proxy's `ColdStartInfo` enum, which has no `cold`
   * variant. Sending one fails the whole response with `unknown variant \`cold\`` and the client
   * sees only "Control plane request failed"; a start from nothing is `pool_miss`. Measured on
   * proxy build 8464.
   */
  it('starts a suspended compute on demand and reports a pool miss', async () => {
    const { endpointId } = await seed();
    await reconciler.drain();
    await app.request(`/api/v2/projects/${(await seedProjectId())}/endpoints/${endpointId}/suspend`, { method: 'POST' });
    await reconciler.drain();
    expect(repos.endpoints.get(endpointId)?.current_state).toBe('idle');

    const response = await app.request(`/cplane/wake_compute?endpointish=${endpointId}`, { headers: auth });
    expect(response.status, await response.clone().text()).toBe(200);
    const body = (await response.json()) as { aux: Record<string, unknown> };
    expect(body.aux.cold_start_info).toBe('pool_miss');
    expect(repos.endpoints.get(endpointId)?.current_state).toBe('active');
  });

  it('only ever emits a cold_start_info the proxy enum accepts', async () => {
    const { endpointId } = await seed();
    await reconciler.drain();
    const accepted = ['unknown', 'warm', 'pool_hit', 'pool_miss', 'http_pool_hit', 'warm_cached'];
    const response = await app.request(`/cplane/wake_compute?endpointish=${endpointId}`, { headers: auth });
    const body = (await response.json()) as { aux: Record<string, unknown> };
    expect(accepted).toContain(body.aux.cold_start_info);
  });

  async function seedProjectId(): Promise<string> {
    const list = (await (await app.request('/api/v2/projects')).json()) as { projects: Array<{ id: string }> };
    return list.projects[0]!.id;
  }

  it('refuses missing, wrong, and unconfigured proxy authentication', async () => {
    const { endpointId } = await seed();
    expect((await app.request(`/cplane/wake_compute?endpointish=${endpointId}`)).status).toBe(401);
    expect((await app.request(`/cplane/wake_compute?endpointish=${endpointId}`, { headers: { authorization: 'Bearer wrong' } })).status).toBe(401);

    build(false);
    const seeded = await seed();
    await reconciler.drain();
    expect((await app.request(`/cplane/wake_compute?endpointish=${seeded.endpointId}`)).status).toBe(401);
  });

  it('refuses a disabled endpoint', async () => {
    const { projectId, endpointId } = await seed();
    await reconciler.drain();
    await app.request(`/api/v2/projects/${projectId}/endpoints/${endpointId}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: { disabled: true } }),
    });
    const response = await app.request(`/cplane/wake_compute?endpointish=${endpointId}`, { headers: auth });
    expect(response.status).toBe(400);
  });
});

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
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
import type { DockerClient } from '../../src/adapters/docker.ts';
import { fakeAdapters, type FakeAdapters } from '../support/fakes.ts';
import { authed, bootstrapForTest, testIdentity } from '../support/identity.ts';

/**
 * The local operations console (`/console/state`). It is not part of the Neon contract, so it is
 * not validated against the vendored OpenAPI schema — these assertions are its contract instead.
 *
 * Two of them are the reason the endpoint exists at all:
 *   - it reports **drift**, where the stored endpoint state and the real container disagree;
 *   - it never carries a password, even though it walks every role in the stack.
 */

const workdir = mkdtempSync(join(tmpdir(), 'neon-cp-console-'));
configureRespond({ validate: true });

let repos: Repositories;
let app: Hono<AppEnv>;
let rawApp: Hono<AppEnv>;
let reconciler: Reconciler;
let fakes: FakeAdapters;

function config(): Config {
  return {
    port: 0, dbPath: ':memory:', masterKey: randomBytes(32),
    pageserverUrl: 'http://pageserver.invalid', pageserverConnstring: 'host=pageserver port=6400',
    safekeepers: ['safekeeper1:5454'], neonTag: 'test', computeImageRepo: 'docker.io/neondatabase',
    dockerSocket: '/var/run/docker.sock', dockerNetwork: 'neon-cp-test',
    computeVolumeRoot: join(workdir, 'computes'), portRange: [55600, 55620],
    routeMode: 'proxy', zone: 'db.neon.localhost',
    proxyToken: undefined, validateResponses: true,
    identity: testIdentity(),
  };
}

function build(docker?: DockerClient): void {
  const cfg = config();
  repos = createRepositories(openDatabase(':memory:'));
  bootstrapForTest(repos, cfg.identity);
  fakes = fakeAdapters();
  const dockerClient = docker ?? fakes.docker;
  const service = createService({ repos, pageserver: fakes.pageserver, config: cfg, logger: nullLogger });
  reconciler = createReconciler({
    repos, pageserver: fakes.pageserver, docker: dockerClient, compute: fakes.compute,
    signer: createComputeSigner('test'), config: cfg, logger: nullLogger,
  });
  rawApp = createApp({
    repos, service, config: cfg, logger: nullLogger, reconciler,
    docker: dockerClient, pageserver: fakes.pageserver,
  });
  app = authed(rawApp);
}

interface Snapshot {
  health: { docker: { ok: boolean }; pageserver: { ok: boolean }; api_keys: number; route_mode: string };
  summary: Record<string, number>;
  projects: Array<{
    id: string; name: string;
    branches: Array<{ id: string; roles: Array<Record<string, unknown>>; databases: Array<{ name: string }> }>;
    endpoints: Array<{ id: string; state: string; container: string; drift: string | null }>;
  }>;
  operations: Array<{ action: string; status: string }>;
}

async function snapshot(headers: Record<string, string> = {}): Promise<Snapshot> {
  const response = await app.request('/console/state', { headers });
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as Snapshot;
}

/** Creates a project and drains the reconciler so its compute is really up. */
async function seed(name = 'console'): Promise<{ projectId: string; endpointId: string; password: string }> {
  const created = (await (await app.request('/api/v2/projects', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project: { name } }),
  })).json()) as Record<string, unknown>;
  await reconciler.drain();
  return {
    projectId: (created.project as { id: string }).id,
    endpointId: (created.endpoints as Array<{ id: string }>)[0]!.id,
    password: (created.roles as Array<{ password: string }>)[0]!.password,
  };
}

beforeEach(() => build());
afterAll(() => rmSync(workdir, { recursive: true, force: true }));

describe('local operations console', () => {
  it('serves the page at both / and /console without an API key', async () => {
    for (const path of ['/', '/console']) {
      const response = await app.request(path);
      expect(response.status, path).toBe(200);
      expect(response.headers.get('content-type')).toMatch(/text\/html/);
      const html = await response.text();
      expect(html).toContain('<title>Neon 本地控制面</title>');
      // The page must not ship a CDN reference: this tool has to work with the network down.
      expect(html).not.toMatch(/src="https?:\/\//);
    }
  });

  it('reports the whole stack in one snapshot', async () => {
    const { projectId, endpointId } = await seed();
    const state = await snapshot();

    expect(state.health.route_mode).toBe('proxy');
    expect(state.health.docker.ok).toBe(true);
    expect(state.health.pageserver.ok).toBe(true);
    expect(state.summary).toMatchObject({ projects: 1, endpoints: 1, running_computes: 1, drifting_endpoints: 0 });

    const project = state.projects[0]!;
    expect(project.id).toBe(projectId);
    expect(project.branches).toHaveLength(1);
    expect(project.branches[0]!.roles.map((role) => role.name)).toContain('neondb_owner');
    expect(project.branches[0]!.databases.map((database) => database.name)).toContain('neondb');
    expect(project.endpoints[0]).toMatchObject({ id: endpointId, state: 'active', container: 'running', drift: null });
    expect(state.operations.map((operation) => operation.action)).toContain('start_compute');
  });

  /**
   * The snapshot walks every role in the stack, so a careless field would hand out every password
   * on the box to anyone who can load a page. Passwords are reachable only through the v2
   * `reveal_password` route, on an explicit request for one role.
   */
  it('never carries a password or a SCRAM verifier', async () => {
    const { password } = await seed();
    const raw = await (await app.request('/console/state')).text();

    expect(raw).not.toContain(password);
    expect(raw).not.toContain('SCRAM-SHA-256');
    expect(raw).not.toMatch(/password_ciphertext|scram_secret/);
    // The fact that a password exists is fine to show; the value is not.
    const state = JSON.parse(raw) as Snapshot;
    expect(state.projects[0]!.branches[0]!.roles[0]).toHaveProperty('has_stored_password', true);
  });

  it('flags an endpoint whose container disappeared behind the control plane', async () => {
    const { endpointId } = await seed();
    // Exactly what `docker rm -f <endpoint>` does while the row still says active.
    fakes.state.containers.delete(endpointId);

    const state = await snapshot();
    expect(state.projects[0]!.endpoints[0]).toMatchObject({ state: 'active', container: 'missing', drift: 'container_missing' });
    expect(state.summary.drifting_endpoints).toBe(1);
  });

  it('flags a stopped container under an active endpoint, and a running one under an idle endpoint', async () => {
    const { projectId, endpointId } = await seed();

    fakes.state.containers.get(endpointId)!.running = false;
    expect((await snapshot()).projects[0]!.endpoints[0]!.drift).toBe('container_stopped');

    await app.request(`/api/v2/projects/${projectId}/endpoints/${endpointId}/suspend`, { method: 'POST' });
    await reconciler.drain();
    fakes.state.containers.set(endpointId, { id: 'c', running: true, labels: { 'neon-cp.endpoint_id': endpointId } });
    expect((await snapshot()).projects[0]!.endpoints[0]!.drift).toBe('still_running');
  });

  it('claims no drift when docker cannot be reached', async () => {
    const broken: DockerClient = { ...fakeAdapters().docker, listByLabel: async () => { throw new Error('socket is gone'); } };
    build(broken);
    await seed();

    const state = await snapshot();
    expect(state.health.docker.ok).toBe(false);
    // 'unknown' rather than 'missing': an unreachable docker is not evidence that anything is wrong.
    expect(state.projects[0]!.endpoints[0]!.container).toBe('unknown');
    expect(state.projects[0]!.endpoints[0]!.drift).toBeNull();
    expect(state.summary.drifting_endpoints).toBe(0);
  });

  it('requires a credential for the snapshot but still serves the page', async () => {
    await seed();

    // The raw app has no credential injected: the snapshot is refused, the page is not.
    expect((await rawApp.request('/console/state')).status).toBe(401);
    expect((await rawApp.request('/console/state', { headers: { authorization: 'Bearer wrong' } })).status).toBe(401);
    expect((await snapshot()).summary.projects).toBe(1);
    // The page itself is a shell with no data in it; it prompts for a login when the fetch 401s.
    expect((await rawApp.request('/console')).status).toBe(200);
  });

  it('lists operations across every project, newest first', async () => {
    await seed('one');
    await seed('two');
    const state = await snapshot();

    const projectIds = new Set(state.operations.map((operation) => (operation as unknown as { project_id: string }).project_id));
    expect(projectIds.size).toBe(2);
    const timestamps = state.operations.map((operation) => (operation as unknown as { created_at: string }).created_at);
    expect([...timestamps].sort().reverse()).toEqual(timestamps);
  });
});

import { randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
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
import { fakeAdapters, type FakeAdapters } from '../support/fakes.ts';
import { authed, bootstrapForTest, testIdentity } from '../support/identity.ts';

/**
 * The whole API over stubbed adapters (002 §12.1 contract tier). Response validation is on, so
 * every assertion here is also a schema assertion.
 */

const workdir = mkdtempSync(join(tmpdir(), 'neon-cp-test-'));
configureRespond({ validate: true });

let repos: Repositories;
let app: Hono<AppEnv>;
let reconciler: Reconciler;
let fakes: FakeAdapters;

function makeConfig(): Config {
  return {
    port: 0,
    dbPath: ':memory:',
    masterKey: randomBytes(32),
    pageserverUrl: 'http://pageserver.invalid',
    pageserverConnstring: 'host=pageserver port=6400',
    safekeepers: ['safekeeper1:5454'],
    neonTag: 'test',
    computeImageRepo: 'docker.io/neondatabase',
    dockerSocket: '/var/run/docker.sock',
    dockerNetwork: 'neon-cp-test',
    computeVolumeRoot: join(workdir, 'computes'),
    portRange: [55500, 55520],
    routeMode: 'proxy',
    zone: 'db.siteops.localhost',
    proxyToken: undefined,
    validateResponses: true,
    identity: testIdentity(),
  };
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

async function createProject(body: unknown = { project: { name: 'demo', pg_version: 17 } }): Promise<Record<string, unknown>> {
  const response = await app.request('/api/v2/projects', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  expect(response.status, await response.clone().text()).toBe(201);
  return json(response);
}

beforeEach(() => {
  const config = makeConfig();
  repos = createRepositories(openDatabase(':memory:'));
  bootstrapForTest(repos, config.identity);
  fakes = fakeAdapters();
  const service = createService({ repos, pageserver: fakes.pageserver, config, logger: nullLogger });
  reconciler = createReconciler({
    repos, pageserver: fakes.pageserver, docker: fakes.docker, compute: fakes.compute,
    signer: createComputeSigner('test'), config, logger: nullLogger,
  });
  app = authed(createApp({ repos, service, config, logger: nullLogger, reconciler }));
});

afterAll(() => rmSync(workdir, { recursive: true, force: true }));

describe('health', () => {
  it('answers healthz and readyz', async () => {
    expect((await app.request('/healthz')).status).toBe(200);
    const ready = await json(await app.request('/readyz'));
    expect(ready).toMatchObject({ status: 'ok', route_mode: 'proxy' });
  });

  it('stamps a request id and the routing mode on every response', async () => {
    const response = await app.request('/api/v2/projects');
    expect(response.headers.get('x-request-id')).toBeTruthy();
    expect(response.headers.get('x-neon-cp-mode')).toBe('proxy');
  });
});

describe('projects', () => {
  it('applies roles and databases created after a starting compute has captured its spec', async () => {
    const created = await createProject();
    const projectId = (created.project as Record<string, unknown>).id as string;
    const branchId = (created.branch as Record<string, unknown>).id as string;
    let release!: () => void;
    let started!: () => void;
    const captured = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const waitForStatus = fakes.compute.waitForStatus;
    fakes.compute.waitForStatus = async (...args) => { started(); await gate; return waitForStatus(...args); };
    const starting = reconciler.tick();
    await captured;
    try {
      const role = await app.request(`/api/v2/projects/${projectId}/branches/${branchId}/roles`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: { name: 'owner-after-start' } }),
      });
      expect(role.status).toBe(201);
      const database = await app.request(`/api/v2/projects/${projectId}/branches/${branchId}/databases`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ database: { name: 'after_start', owner_name: 'owner-after-start' } }),
      });
      expect(database.status).toBe(201);
      expect(fakes.state.configureCalls).toHaveLength(0);
    } finally { release(); await starting; }
    await reconciler.drain();
    const applied = JSON.stringify(fakes.state.configureCalls.at(-1)?.spec);
    expect(applied).toContain('owner-after-start');
    expect(applied).toContain('after_start');
  });

  it('creates a project with a branch, role, database, endpoint and connection uri', async () => {
    const body = await createProject();
    const project = body.project as Record<string, unknown>;
    const branch = body.branch as Record<string, unknown>;
    const roles = body.roles as Array<Record<string, unknown>>;
    const databases = body.databases as Array<Record<string, unknown>>;
    const endpoints = body.endpoints as Array<Record<string, unknown>>;
    const uris = body.connection_uris as Array<Record<string, unknown>>;

    expect(String(project.id)).toMatch(/^[a-z0-9-]{1,60}$/);
    expect(project.pg_version).toBe(17);
    expect(branch.name).toBe('main');
    expect(branch.default).toBe(true);
    expect(roles[0]!.name).toBe('neondb_owner');
    expect(String(roles[0]!.password).length).toBeGreaterThan(10);
    expect(databases[0]).toMatchObject({ name: 'neondb', owner_name: 'neondb_owner' });
    expect(endpoints[0]!.current_state).toBe('init');
    expect(String(uris[0]!.connection_uri)).toMatch(/^postgresql:\/\/neondb_owner:.+@ep-.+\.db\.siteops\.localhost\/neondb\?sslmode=require&channel_binding=require$/);

    // the storage side really was driven
    expect(fakes.state.tenants.size).toBe(1);
    expect(fakes.state.timelines.size).toBe(1);
  });

  it('lists, reads, patches and deletes', async () => {
    const created = await createProject();
    const id = (created.project as Record<string, unknown>).id as string;

    const list = await json(await app.request('/api/v2/projects'));
    expect((list.projects as unknown[]).length).toBe(1);

    const read = await json(await app.request(`/api/v2/projects/${id}`));
    expect((read.project as Record<string, unknown>).id).toBe(id);

    const patched = await json(await app.request(`/api/v2/projects/${id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project: { name: 'renamed' } }),
    }));
    expect((patched.project as Record<string, unknown>).name).toBe('renamed');

    expect((await app.request(`/api/v2/projects/${id}`, { method: 'DELETE' })).status).toBe(200);
    await reconciler.drain();
    expect((await app.request(`/api/v2/projects/${id}`)).status).toBe(404);
    expect(fakes.state.tenants.size).toBe(0);
  });

  it('404s an unknown project with a GeneralError body', async () => {
    const response = await app.request('/api/v2/projects/nope-nope-000000');
    expect(response.status).toBe(404);
    const body = await json(response);
    expect(body).toMatchObject({ code: 'PROJECT_NOT_FOUND' });
    expect(body.request_id).toBeTruthy();
  });

  it('rejects an unsupported pg_version', async () => {
    const response = await app.request('/api/v2/projects', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project: { pg_version: 9 } }),
    });
    expect(response.status).toBe(400);
  });
});

describe('branches', () => {
  it('creates a child branch from the default branch and starts its endpoint', async () => {
    const created = await createProject();
    const projectId = (created.project as Record<string, unknown>).id as string;

    const response = await app.request(`/api/v2/projects/${projectId}/branches`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        branch: { name: 'feature' },
        endpoints: [{ type: 'read_write' }],
        annotation_value: { siteops_logical_resource_id: 'lr_1', siteops_workspace_id: 'ws_1' },
      }),
    });
    expect(response.status, await response.clone().text()).toBe(201);
    const body = await json(response);
    const branch = body.branch as Record<string, unknown>;

    expect(String(branch.id)).toMatch(/^br-/);
    expect(branch.parent_id).toBeTruthy();
    expect(branch.parent_lsn).toBeTruthy();
    // SiteOps reads this back to reconcile its own resources.
    expect(branch.annotation_value).toEqual({ siteops_logical_resource_id: 'lr_1', siteops_workspace_id: 'ws_1' });
    expect((body.endpoints as unknown[]).length).toBe(1);
    expect(fakes.state.timelines.size).toBe(2);
  });

  it('resolves parent_timestamp through the pageserver and refuses one outside the window', async () => {
    const created = await createProject();
    const projectId = (created.project as Record<string, unknown>).id as string;

    const ok = await app.request(`/api/v2/projects/${projectId}/branches`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ branch: { name: 'pitr', parent_timestamp: new Date().toISOString() } }),
    });
    expect(ok.status, await ok.clone().text()).toBe(201);

    fakes.state.lsnForTimestamp = '0/1';
    const tooOld = await app.request(`/api/v2/projects/${projectId}/branches`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ branch: { name: 'ancient', parent_timestamp: '2000-01-01T00:00:00.000Z' } }),
    });
    expect(tooOld.status).toBe(400);
    expect((await json(tooOld)).code).toBe('WRONG_LSN_OR_TIMESTAMP');
  });

  it('refuses to delete the default branch and deletes a child', async () => {
    const created = await createProject();
    const projectId = (created.project as Record<string, unknown>).id as string;
    const defaultBranchId = (created.branch as Record<string, unknown>).id as string;

    expect((await app.request(`/api/v2/projects/${projectId}/branches/${defaultBranchId}`, { method: 'DELETE' })).status).toBe(400);

    const child = await json(await app.request(`/api/v2/projects/${projectId}/branches`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ branch: { name: 'temp' } }),
    }));
    const childId = (child.branch as Record<string, unknown>).id as string;

    const deleted = await app.request(`/api/v2/projects/${projectId}/branches/${childId}`, { method: 'DELETE' });
    expect(deleted.status).toBe(200);
    expect(((await json(deleted)).operations as unknown[]).length).toBe(1);
    await reconciler.drain();
    expect((await app.request(`/api/v2/projects/${projectId}/branches/${childId}`)).status).toBe(404);
  });

  it('moves the default flag', async () => {
    const created = await createProject();
    const projectId = (created.project as Record<string, unknown>).id as string;
    const child = await json(await app.request(`/api/v2/projects/${projectId}/branches`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ branch: { name: 'next' } }),
    }));
    const childId = (child.branch as Record<string, unknown>).id as string;

    const promoted = await json(await app.request(`/api/v2/projects/${projectId}/branches/${childId}/set_as_default`, { method: 'POST' }));
    expect((promoted.branch as Record<string, unknown>).default).toBe(true);
    const list = await json(await app.request(`/api/v2/projects/${projectId}/branches`));
    const defaults = (list.branches as Array<Record<string, unknown>>).filter((row) => row.default === true);
    expect(defaults).toHaveLength(1);
  });
});

describe('roles and databases', () => {
  it('creates a role, reveals and resets its password, then deletes it with a delta operation', async () => {
    const created = await createProject();
    const projectId = (created.project as Record<string, unknown>).id as string;
    const branchId = (created.branch as Record<string, unknown>).id as string;
    await reconciler.drain(); // bring the endpoint up so apply_config has a target

    const roleResponse = await app.request(`/api/v2/projects/${projectId}/branches/${branchId}/roles`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: { name: 'app_user' } }),
    });
    expect(roleResponse.status, await roleResponse.clone().text()).toBe(201);
    const roleBody = await json(roleResponse);
    const firstPassword = (roleBody.role as Record<string, unknown>).password as string;
    expect(firstPassword).toBeTruthy();

    const revealed = await json(await app.request(`/api/v2/projects/${projectId}/branches/${branchId}/roles/app_user/reveal_password`));
    expect(revealed.password).toBe(firstPassword);

    const reset = await json(await app.request(`/api/v2/projects/${projectId}/branches/${branchId}/roles/app_user/reset_password`, { method: 'POST' }));
    const secondPassword = (reset.role as Record<string, unknown>).password as string;
    expect(secondPassword).not.toBe(firstPassword);

    await reconciler.drain();
    const deleted = await app.request(`/api/v2/projects/${projectId}/branches/${branchId}/roles/app_user`, { method: 'DELETE' });
    expect(deleted.status).toBe(200);
    await reconciler.drain();

    // compute_ctl only drops a role when told explicitly, so the delta must have been sent.
    const deltas = fakes.state.configureCalls.flatMap((call) => (call.spec.spec.delta_operations ?? []) as Array<Record<string, unknown>>);
    expect(deltas).toContainEqual({ action: 'delete_role', name: 'app_user' });
  });

  it('refuses to delete a role that owns a database', async () => {
    const created = await createProject();
    const projectId = (created.project as Record<string, unknown>).id as string;
    const branchId = (created.branch as Record<string, unknown>).id as string;
    const response = await app.request(`/api/v2/projects/${projectId}/branches/${branchId}/roles/neondb_owner`, { method: 'DELETE' });
    expect(response.status).toBe(400);
  });

  it('creates and deletes a database, and rejects an unknown owner', async () => {
    const created = await createProject();
    const projectId = (created.project as Record<string, unknown>).id as string;
    const branchId = (created.branch as Record<string, unknown>).id as string;

    const bad = await app.request(`/api/v2/projects/${projectId}/branches/${branchId}/databases`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ database: { name: 'x', owner_name: 'ghost' } }),
    });
    expect(bad.status).toBe(404);

    const good = await app.request(`/api/v2/projects/${projectId}/branches/${branchId}/databases`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ database: { name: 'analytics', owner_name: 'neondb_owner' } }),
    });
    expect(good.status, await good.clone().text()).toBe(201);

    const list = await json(await app.request(`/api/v2/projects/${projectId}/branches/${branchId}/databases`));
    expect((list.databases as Array<Record<string, unknown>>).map((row) => row.name).sort()).toEqual(['analytics', 'neondb']);

    expect((await app.request(`/api/v2/projects/${projectId}/branches/${branchId}/databases/analytics`, { method: 'DELETE' })).status).toBe(200);
    const after = await json(await app.request(`/api/v2/projects/${projectId}/branches/${branchId}/databases`));
    expect((after.databases as unknown[]).length).toBe(1);
  });

  it('refuses reveal_password when the project does not store passwords', async () => {
    const created = await createProject({ project: { name: 'nostore', store_passwords: false } });
    const projectId = (created.project as Record<string, unknown>).id as string;
    const branchId = (created.branch as Record<string, unknown>).id as string;
    const response = await app.request(`/api/v2/projects/${projectId}/branches/${branchId}/roles/neondb_owner/reveal_password`);
    expect(response.status).toBe(412);
    expect((await json(response)).code).toBe('PRECONDITION_FAILED');
  });
});

describe('endpoints', () => {
  it('runs the full lifecycle: create, start, suspend, restart, delete', async () => {
    const created = await createProject();
    const projectId = (created.project as Record<string, unknown>).id as string;
    const endpointId = ((created.endpoints as Array<Record<string, unknown>>)[0]!).id as string;

    await reconciler.drain();
    let endpoint = await json(await app.request(`/api/v2/projects/${projectId}/endpoints/${endpointId}`));
    expect((endpoint.endpoint as Record<string, unknown>).current_state).toBe('active');
    expect(fakes.state.containers.get(endpointId)?.running).toBe(true);

    expect((await app.request(`/api/v2/projects/${projectId}/endpoints/${endpointId}/suspend`, { method: 'POST' })).status).toBe(200);
    await reconciler.drain();
    endpoint = await json(await app.request(`/api/v2/projects/${projectId}/endpoints/${endpointId}`));
    expect((endpoint.endpoint as Record<string, unknown>).current_state).toBe('idle');
    expect(fakes.state.containers.get(endpointId)?.running).toBe(false);

    expect((await app.request(`/api/v2/projects/${projectId}/endpoints/${endpointId}/start`, { method: 'POST' })).status).toBe(200);
    await reconciler.drain();
    endpoint = await json(await app.request(`/api/v2/projects/${projectId}/endpoints/${endpointId}`));
    expect((endpoint.endpoint as Record<string, unknown>).current_state).toBe('active');

    expect((await app.request(`/api/v2/projects/${projectId}/endpoints/${endpointId}`, { method: 'DELETE' })).status).toBe(200);
    expect((await app.request(`/api/v2/projects/${projectId}/endpoints/${endpointId}`)).status).toBe(404);
  });

  it('keeps the endpoint name the client sets, on create and on update', async () => {
    const created = await createProject();
    const projectId = (created.project as Record<string, unknown>).id as string;
    const branchId = (created.branch as Record<string, unknown>).id as string;

    const posted = await json(await app.request(`/api/v2/projects/${projectId}/endpoints`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: { branch_id: branchId, type: 'read_only', name: 'analytics' } }),
    }));
    const endpointId = (posted.endpoint as Record<string, unknown>).id as string;
    expect((posted.endpoint as Record<string, unknown>).name).toBe('analytics');

    const patched = await json(await app.request(`/api/v2/projects/${projectId}/endpoints/${endpointId}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: { name: 'analytics-v2' } }),
    }));
    expect((patched.endpoint as Record<string, unknown>).name).toBe('analytics-v2');

    const fetched = await json(await app.request(`/api/v2/projects/${projectId}/endpoints/${endpointId}`));
    expect((fetched.endpoint as Record<string, unknown>).name).toBe('analytics-v2');
  });

  it('allows only one read_write endpoint per branch', async () => {
    const created = await createProject();
    const projectId = (created.project as Record<string, unknown>).id as string;
    const branchId = (created.branch as Record<string, unknown>).id as string;

    const second = await app.request(`/api/v2/projects/${projectId}/endpoints`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: { branch_id: branchId, type: 'read_write' } }),
    });
    expect(second.status).toBe(409);

    const readOnly = await app.request(`/api/v2/projects/${projectId}/endpoints`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: { branch_id: branchId, type: 'read_only' } }),
    });
    expect(readOnly.status, await readOnly.clone().text()).toBe(201);
  });

  it('starts a read_only endpoint in Replica mode', async () => {
    const created = await createProject();
    const projectId = (created.project as Record<string, unknown>).id as string;
    const branchId = (created.branch as Record<string, unknown>).id as string;
    await app.request(`/api/v2/projects/${projectId}/endpoints`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: { branch_id: branchId, type: 'read_only' } }),
    });
    await reconciler.drain();
    // start_compute writes the spec to the mounted file rather than posting it, so read them back.
    const modes = readdirSync(join(workdir, 'computes')).map((endpointId) =>
      (JSON.parse(readFileSync(join(workdir, 'computes', endpointId, 'spec', 'config.json'), 'utf8')) as { spec: { mode: string } }).spec.mode);
    expect(modes).toContain('Primary');
    expect(modes).toContain('Replica');
  });
});

describe('operations', () => {
  it('reports the lifecycle of an operation', async () => {
    const created = await createProject();
    const projectId = (created.project as Record<string, unknown>).id as string;
    const operationId = ((created.operations as Array<Record<string, unknown>>).find((row) => row.action === 'start_compute'))!.id as string;

    let operation = await json(await app.request(`/api/v2/projects/${projectId}/operations/${operationId}`));
    expect((operation.operation as Record<string, unknown>).status).toBe('scheduling');

    await reconciler.drain();
    operation = await json(await app.request(`/api/v2/projects/${projectId}/operations/${operationId}`));
    expect((operation.operation as Record<string, unknown>).status).toBe('finished');
    expect(Number((operation.operation as Record<string, unknown>).total_duration_ms)).toBeGreaterThanOrEqual(0);

    const list = await json(await app.request(`/api/v2/projects/${projectId}/operations`));
    expect((list.operations as unknown[]).length).toBeGreaterThanOrEqual(2);
  });

  it('retries a failing step with backoff and gives up after five failures', async () => {
    const created = await createProject();
    const projectId = (created.project as Record<string, unknown>).id as string;
    const operationId = ((created.operations as Array<Record<string, unknown>>).find((row) => row.action === 'start_compute'))!.id as string;

    fakes.state.failComputeStatus = true;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      // Clear retry_at so the loop can pick the operation up again immediately.
      repos.db.prepare('UPDATE operations SET retry_at = NULL WHERE id = ?').run(operationId);
      await reconciler.drain(1);
    }
    const operation = await json(await app.request(`/api/v2/projects/${projectId}/operations/${operationId}`));
    const row = operation.operation as Record<string, unknown>;
    expect(row.status).toBe('failed');
    expect(row.failures_count).toBe(5);
    expect(String(row.error)).toContain('step await_ready');
  });

  it('resumes from the recorded step after a restart', async () => {
    const created = await createProject();
    const operationId = ((created.operations as Array<Record<string, unknown>>).find((row) => row.action === 'start_compute'))!.id as string;

    fakes.state.failComputeStatus = true;
    await reconciler.drain(1);
    expect(repos.operations.get(operationId)?.cursor_step).toBe(3); // write_spec, ensure_container, start_container

    fakes.state.failComputeStatus = false;
    fakes.state.createCalls = 0;
    repos.db.prepare('UPDATE operations SET retry_at = NULL WHERE id = ?').run(operationId);
    await reconciler.drain(1);
    expect(repos.operations.get(operationId)?.status).toBe('finished');
    // The already-completed container steps were not run again.
    expect(fakes.state.createCalls).toBe(0);
  });
});

describe('connection_uri', () => {
  it('returns a URI for the default branch and rejects an unknown database', async () => {
    const created = await createProject();
    const projectId = (created.project as Record<string, unknown>).id as string;

    const ok = await json(await app.request(`/api/v2/projects/${projectId}/connection_uri?database_name=neondb&role_name=neondb_owner`));
    expect(String(ok.uri)).toContain('postgresql://neondb_owner:');

    const missing = await app.request(`/api/v2/projects/${projectId}/connection_uri?database_name=ghost&role_name=neondb_owner`);
    expect(missing.status).toBe(404);

    const noParams = await app.request(`/api/v2/projects/${projectId}/connection_uri`);
    expect(noParams.status).toBe(400);
  });
});

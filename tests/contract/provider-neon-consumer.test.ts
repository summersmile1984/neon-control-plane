import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { openDatabase } from '../../src/store/db.ts';
import { createRepositories } from '../../src/store/repo.ts';
import { createService } from '../../src/service.ts';
import { createApp, type AppEnv } from '../../src/http/app.ts';
import { configureRespond } from '../../src/http/respond.ts';
import { createReconciler } from '../../src/reconciler/loop.ts';
import { createComputeSigner } from '../../src/domain/compute-auth.ts';
import { nullLogger } from '../../src/logger.ts';
import type { Config } from '../../src/config.ts';
import { fakeAdapters } from '../support/fakes.ts';
import { authed, bootstrapForTest, testIdentity } from '../support/identity.ts';

/**
 * T-109 / 002 §12.2 item 2: the rules `siteops-platform/packages/provider-neon` applies to every
 * response. Its mappers silently drop anything that fails these, so a violation here is a silent
 * outage on the consumer side rather than a visible error.
 *
 * Patterns copied verbatim from that package:
 *   project    /^[a-z0-9-]{1,60}$/
 *   branch     /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
 *   identifier /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/
 *   name       /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/
 *   host       /^[A-Za-z0-9.-]{1,253}$/
 */
const PROJECT = /^[a-z0-9-]{1,60}$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
const HOST = /^[A-Za-z0-9.-]{1,253}$/;

const workdir = mkdtempSync(join(tmpdir(), 'neon-cp-consumer-'));
configureRespond({ validate: true });

let app: Hono<AppEnv>;
let drain: () => Promise<number>;

beforeEach(() => {
  const config: Config = {
    port: 0, dbPath: ':memory:', masterKey: randomBytes(32),
    pageserverUrl: 'http://pageserver.invalid', pageserverConnstring: 'host=pageserver port=6400',
    safekeepers: ['safekeeper1:5454'], neonTag: 'test', computeImageRepo: 'docker.io/neondatabase',
    dockerSocket: '/var/run/docker.sock', dockerNetwork: 'neon-cp-test',
    computeVolumeRoot: join(workdir, 'computes'), portRange: [55500, 55520],
    routeMode: 'proxy', zone: 'db.siteops.localhost', proxyToken: undefined, validateResponses: true,
    identity: testIdentity(),
  };
  const repos = createRepositories(openDatabase(':memory:'));
  bootstrapForTest(repos, config.identity);
  const fakes = fakeAdapters();
  const service = createService({ repos, pageserver: fakes.pageserver, config, logger: nullLogger });
  const reconciler = createReconciler({
    repos, pageserver: fakes.pageserver, docker: fakes.docker, compute: fakes.compute,
    signer: createComputeSigner('test'), config, logger: nullLogger,
  });
  app = authed(createApp({ repos, service, config, logger: nullLogger, reconciler }));
  drain = () => reconciler.drain();
});

afterAll(() => rmSync(workdir, { recursive: true, force: true }));

async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  expect(response.status, `${path}: ${await response.clone().text()}`).toBeLessThan(300);
  return (await response.json()) as Record<string, unknown>;
}

async function get(path: string): Promise<Record<string, unknown>> {
  const response = await app.request(path);
  expect(response.status, `${path}: ${await response.clone().text()}`).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

describe('SiteOps provider-neon consumer contract', () => {
  it('every identifier matches the pattern the consumer validates', async () => {
    const created = await post('/api/v2/projects', { project: { name: 'siteops', pg_version: 17 } });
    const project = created.project as Record<string, unknown>;
    const branch = created.branch as Record<string, unknown>;
    const endpoint = (created.endpoints as Array<Record<string, unknown>>)[0]!;
    const role = (created.roles as Array<Record<string, unknown>>)[0]!;
    const database = (created.databases as Array<Record<string, unknown>>)[0]!;

    expect(String(project.id), 'project id').toMatch(PROJECT);
    expect(String(branch.id), 'branch id').toMatch(BRANCH);
    expect(String(endpoint.id), 'endpoint id').toMatch(IDENTIFIER);
    expect(String(endpoint.host), 'endpoint host').toMatch(HOST);
    expect(String(role.name), 'role name').toMatch(NAME);
    expect(String(database.name), 'database name').toMatch(NAME);
  });

  it('branch responses carry the fields branchFrom() reads', async () => {
    const created = await post('/api/v2/projects', { project: { name: 'siteops' } });
    const projectId = (created.project as Record<string, unknown>).id as string;

    const branchBody = await post(`/api/v2/projects/${projectId}/branches`, {
      branch: { name: 'consumer' },
      annotation_value: { siteops_logical_resource_id: 'lr_42', siteops_workspace_id: 'ws_42' },
    });
    const branch = branchBody.branch as Record<string, unknown>;

    expect(branch.id).toBeTypeOf('string');
    expect(branch.name).toBe('consumer');
    expect(branch.current_state).toBeTypeOf('string');
    expect(branch.created_at).toBeTypeOf('string');
    expect(branch.updated_at).toBeTypeOf('string');
    expect(branch.parent_id).toBeTypeOf('string');
    // The consumer reconciles its own resources off this echo; dropping it breaks that silently.
    expect(branch.annotation_value).toEqual({ siteops_logical_resource_id: 'lr_42', siteops_workspace_id: 'ws_42' });
  });

  it('endpoint responses carry branch_id, type, host and current_state', async () => {
    const created = await post('/api/v2/projects', { project: { name: 'siteops' } });
    const projectId = (created.project as Record<string, unknown>).id as string;
    const branchId = (created.branch as Record<string, unknown>).id as string;

    const list = await get(`/api/v2/projects/${projectId}/branches/${branchId}/endpoints`);
    const endpoint = (list.endpoints as Array<Record<string, unknown>>)[0]!;
    // endpointFrom() drops the row when branch_id does not match the branch it asked about.
    expect(endpoint.branch_id).toBe(branchId);
    expect(['read_write', 'read_only']).toContain(endpoint.type);
    expect(['init', 'active', 'idle']).toContain(endpoint.current_state);
    expect(String(endpoint.host)).toMatch(HOST);
  });

  it('role responses carry branch_id, protected and authentication_method, with a password only on write', async () => {
    const created = await post('/api/v2/projects', { project: { name: 'siteops' } });
    const projectId = (created.project as Record<string, unknown>).id as string;
    const branchId = (created.branch as Record<string, unknown>).id as string;

    const createdRole = (await post(`/api/v2/projects/${projectId}/branches/${branchId}/roles`, { role: { name: 'siteops_role' } })).role as Record<string, unknown>;
    // roleFrom() requires branch_id to equal the branch it queried.
    expect(createdRole.branch_id).toBe(branchId);
    expect(createdRole.protected).toBe(false);
    expect(createdRole.authentication_method).toBe('password');
    const password = String(createdRole.password);
    expect(password.length).toBeGreaterThanOrEqual(1);
    expect(password.length).toBeLessThanOrEqual(4096);

    const read = (await get(`/api/v2/projects/${projectId}/branches/${branchId}/roles/siteops_role`)).role as Record<string, unknown>;
    expect(read.password, 'GET must not leak the password').toBeUndefined();

    const revealed = await get(`/api/v2/projects/${projectId}/branches/${branchId}/roles/siteops_role/reveal_password`);
    expect(revealed.password).toBe(password);
  });

  it('database responses carry id, name and owner_name', async () => {
    const created = await post('/api/v2/projects', { project: { name: 'siteops' } });
    const projectId = (created.project as Record<string, unknown>).id as string;
    const branchId = (created.branch as Record<string, unknown>).id as string;

    const body = await post(`/api/v2/projects/${projectId}/branches/${branchId}/databases`, {
      database: { name: 'siteops_db', owner_name: 'neondb_owner' },
    });
    const database = body.database as Record<string, unknown>;
    // databaseFrom() takes id when present, else name; both must be usable as a resource ref.
    expect(String(database.id)).toMatch(IDENTIFIER);
    expect(String(database.name)).toMatch(NAME);
    expect(database.owner_name).toBe('neondb_owner');
  });

  it('operations use the spec status vocabulary and reach finished', async () => {
    const created = await post('/api/v2/projects', { project: { name: 'siteops' } });
    const projectId = (created.project as Record<string, unknown>).id as string;
    const allowed = ['scheduling', 'running', 'finished', 'failed', 'error', 'cancelling', 'cancelled', 'skipped'];
    for (const operation of created.operations as Array<Record<string, unknown>>) {
      expect(allowed, String(operation.action)).toContain(String(operation.status));
      expect(operation.id).toMatch(/^[0-9a-f-]{36}$/);
    }
    await drain();
    const list = await get(`/api/v2/projects/${projectId}/operations`);
    const statuses = (list.operations as Array<Record<string, unknown>>).map((row) => row.status);
    expect(statuses.every((status) => allowed.includes(String(status)))).toBe(true);
    expect(statuses).toContain('finished');
  });

  it('the seven provider operations map onto working endpoints', async () => {
    // database.create / preview / observe / health / delete and site_role.converge / delete all
    // reduce to this sequence of calls.
    const created = await post('/api/v2/projects', { project: { name: 'siteops' } });
    const projectId = (created.project as Record<string, unknown>).id as string;
    const branchId = (created.branch as Record<string, unknown>).id as string;
    await drain();

    // database.create -> branch + database
    const preview = await post(`/api/v2/projects/${projectId}/branches`, {
      branch: { name: 'preview' }, endpoints: [{ type: 'read_write' }],
      annotation_value: { siteops_logical_resource_id: 'lr_preview', siteops_workspace_id: 'ws_1' },
    });
    const previewBranch = (preview.branch as Record<string, unknown>).id as string;
    await drain();

    // site_role.converge -> role + reveal
    await post(`/api/v2/projects/${projectId}/branches/${previewBranch}/roles`, { role: { name: 'site_role' } });
    await get(`/api/v2/projects/${projectId}/branches/${previewBranch}/roles/site_role/reveal_password`);

    // database.observe / health -> read the branch and its endpoints
    await get(`/api/v2/projects/${projectId}/branches/${previewBranch}`);
    await get(`/api/v2/projects/${projectId}/branches/${previewBranch}/endpoints`);
    await get(`/api/v2/projects/${projectId}/connection_uri?branch_id=${branchId}&database_name=neondb&role_name=neondb_owner`);

    // site_role.delete then database.delete
    await drain();
    expect((await app.request(`/api/v2/projects/${projectId}/branches/${previewBranch}/roles/site_role`, { method: 'DELETE' })).status).toBe(200);
    expect((await app.request(`/api/v2/projects/${projectId}/branches/${previewBranch}`, { method: 'DELETE' })).status).toBe(200);
    await drain();
    expect((await app.request(`/api/v2/projects/${projectId}/branches/${previewBranch}`)).status).toBe(404);
  });
});

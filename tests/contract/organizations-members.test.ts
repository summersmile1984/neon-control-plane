import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { openDatabase } from '../../src/store/db.ts';
import { createRepositories, type Repositories } from '../../src/store/repo.ts';
import { createService } from '../../src/service.ts';
import { createApp, type AppEnv } from '../../src/http/app.ts';
import { configureRespond } from '../../src/http/respond.ts';
import { createReconciler } from '../../src/reconciler/loop.ts';
import { createComputeSigner } from '../../src/domain/compute-auth.ts';
import { generateApiKey, hashApiKey } from '../../src/http/auth.ts';
import { nullLogger } from '../../src/logger.ts';
import type { Config } from '../../src/config.ts';
import { fakeAdapters } from '../support/fakes.ts';
import { authed, bootstrapForTest, testIdentity, TEST_ORG_ID, TEST_OWNER_ID } from '../support/identity.ts';

/**
 * Organization key management, membership and the scope matrix (design 004). Every response is
 * validated against the vendored official OpenAPI, so a shape drift fails here.
 */

configureRespond({ validate: true });

const VIEWER_ID = '00000000-0000-0000-0000-0000000000bb';
const VIEWER_MEMBER_ID = '00000000-0000-0000-0000-0000000000cc';
const OTHER_ORG_ID = 'org-other-000000000001';

let repos: Repositories;
let app: Hono<AppEnv>;
let rawApp: Hono<AppEnv>;

function makeConfig(): Config {
  return {
    port: 0, dbPath: ':memory:', masterKey: randomBytes(32),
    pageserverUrl: 'http://pageserver.invalid', pageserverConnstring: 'host=pageserver port=6400',
    safekeepers: ['safekeeper1:5454'], neonTag: 'test', computeImageRepo: 'docker.io/neondatabase',
    dockerSocket: '/var/run/docker.sock', dockerNetwork: 'neon-cp-test',
    computeVolumeRoot: '/tmp/neon-cp-orgs', portRange: [55500, 55520],
    routeMode: 'proxy', zone: 'db.neon.localhost', proxyToken: undefined, validateResponses: true,
    identity: testIdentity(),
  };
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

beforeEach(() => {
  const config = makeConfig();
  repos = createRepositories(openDatabase(':memory:'));
  bootstrapForTest(repos, config.identity);
  const fakes = fakeAdapters();
  const service = createService({ repos, pageserver: fakes.pageserver, config, logger: nullLogger });
  const reconciler = createReconciler({
    repos, pageserver: fakes.pageserver, docker: fakes.docker, compute: fakes.compute,
    signer: createComputeSigner('test'), config, logger: nullLogger,
  });
  rawApp = createApp({ repos, service, config, logger: nullLogger, reconciler });
  app = authed(rawApp);
});

async function createProject(name: string, key?: string): Promise<string> {
  const response = await (key ? authed(rawApp, key) : app).request('/api/v2/projects', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project: { name } }),
  });
  expect(response.status, await response.clone().text()).toBe(201);
  return ((await response.json()) as { project: { id: string } }).project.id;
}

async function createOrgKey(body: Record<string, unknown>): Promise<{ id: number; key: string }> {
  const response = await app.request(`/api/v2/organizations/${TEST_ORG_ID}/api_keys`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as { id: number; key: string };
}

function seedViewer(): { memberId: string; key: string } {
  const key = generateApiKey();
  repos.users.insert({ id: VIEWER_ID, email: 'viewer@test.local', name: 'Viewer', last_name: '', image: '', password_hash: null });
  repos.members.insert({ id: VIEWER_MEMBER_ID, org_id: TEST_ORG_ID, user_id: VIEWER_ID, role: 'viewer' });
  repos.apiKeys.insert({ name: 'viewer', key_hash: hashApiKey(key), created_by: VIEWER_ID, kind: 'user' });
  return { memberId: VIEWER_MEMBER_ID, key };
}

describe('organization API keys', () => {
  it('lists and revokes, and a revoked org key stops working', async () => {
    const created = await createOrgKey({ key_name: 'org-one' });

    const list = (await (await app.request(`/api/v2/organizations/${TEST_ORG_ID}/api_keys`)).json()) as Array<Record<string, unknown>>;
    const row = list.find((entry) => entry.id === created.id)!;
    expect(row).toMatchObject({ name: 'org-one' });
    expect(row.key).toBeUndefined();
    expect((row.created_by as Record<string, unknown>).id).toBe(TEST_OWNER_ID);

    expect((await authed(rawApp, created.key).request('/api/v2/projects')).status).toBe(200);
    const revoked = await json(await app.request(`/api/v2/organizations/${TEST_ORG_ID}/api_keys/${created.id}`, { method: 'DELETE' }));
    expect(revoked).toMatchObject({ id: created.id, revoked: true });
    expect((await authed(rawApp, created.key).request('/api/v2/projects')).status).toBe(401);
  });

  it('reports api_key_org and refuses user-centric routes for an org key', async () => {
    const orgKey = await createOrgKey({ key_name: 'org-auth' });
    const orgApp = authed(rawApp, orgKey.key);

    expect((await json(await orgApp.request('/api/v2/auth'))).auth_method).toBe('api_key_org');
    expect((await orgApp.request('/api/v2/users/me')).status).toBe(403);
    expect((await orgApp.request('/api/v2/users/me/organizations')).status).toBe(403);
    expect((await orgApp.request('/api/v2/api_keys')).status).toBe(403);
  });

  it('hides the organization and its API keys from a project-scoped key', async () => {
    const p1 = await createProject('org-scope-one');
    const scoped = await createOrgKey({ key_name: 'scoped', project_id: p1 });
    const scopedApp = authed(rawApp, scoped.key);

    expect((await scopedApp.request(`/api/v2/organizations/${TEST_ORG_ID}/api_keys`)).status).toBe(404);
    expect((await scopedApp.request(`/api/v2/organizations/${TEST_ORG_ID}`)).status).toBe(404);
  });
});

describe('membership', () => {
  it('changes a member role and removes a member', async () => {
    const { memberId } = seedViewer();

    const patched = await json(await app.request(`/api/v2/organizations/${TEST_ORG_ID}/members/${memberId}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: 'editor' }),
    }));
    expect(patched).toMatchObject({ id: memberId, role: 'editor' });

    expect((await app.request(`/api/v2/organizations/${TEST_ORG_ID}/members/${memberId}`, { method: 'DELETE' })).status).toBe(200);
    expect((await app.request(`/api/v2/organizations/${TEST_ORG_ID}/members/${memberId}`)).status).toBe(404);
  });

  it('refuses to demote or remove the last admin', async () => {
    const owner = repos.members.getByUserAndOrg(TEST_OWNER_ID, TEST_ORG_ID)!;
    const demote = await app.request(`/api/v2/organizations/${TEST_ORG_ID}/members/${owner.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: 'viewer' }),
    });
    expect(demote.status).toBe(400);
    expect((await app.request(`/api/v2/organizations/${TEST_ORG_ID}/members/${owner.id}`, { method: 'DELETE' })).status).toBe(400);
  });

  it('404s a member id from another organization', async () => {
    const { memberId } = seedViewer();
    repos.organizations.insert({ id: OTHER_ORG_ID, name: 'Other', handle: OTHER_ORG_ID, plan: 'free', managed_by: 'console' });
    expect((await app.request(`/api/v2/organizations/${OTHER_ORG_ID}/members/${memberId}`)).status).toBe(404);
  });

  it('does not reveal an organization the user is not a member of', async () => {
    repos.organizations.insert({ id: OTHER_ORG_ID, name: 'Other', handle: OTHER_ORG_ID, plan: 'free', managed_by: 'console' });
    expect((await app.request(`/api/v2/organizations/${OTHER_ORG_ID}`)).status).toBe(404);
    expect((await app.request(`/api/v2/organizations/${OTHER_ORG_ID}/members`)).status).toBe(404);
  });
});

describe('scope enforcement', () => {
  it('confines a project-scoped key on nested project routes', async () => {
    const p1 = await createProject('nested-one');
    const p2 = await createProject('nested-two');
    const p2Branch = ((await json(await app.request(`/api/v2/projects/${p2}/branches`))) as { branches: Array<{ id: string }> }).branches[0]!.id;
    const scoped = await createOrgKey({ key_name: 'nested', project_id: p1 });
    const scopedApp = authed(rawApp, scoped.key);

    expect((await scopedApp.request(`/api/v2/projects/${p2}/branches`)).status).toBe(404);
    expect((await scopedApp.request(`/api/v2/projects/${p2}/branches/${p2Branch}`)).status).toBe(404);
    expect((await scopedApp.request(`/api/v2/projects/${p2}/operations`)).status).toBe(404);
    expect((await scopedApp.request(`/api/v2/projects/${p2}/connection_uri?database_name=neondb&role_name=neondb_owner`)).status).toBe(404);
  });

  it('honors an explicit org_id and rejects an org the user does not belong to', async () => {
    const ok = await app.request('/api/v2/projects', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project: { name: 'explicit-org' } }),
    });
    expect(ok.status, await ok.clone().text()).toBe(201);

    repos.organizations.insert({ id: OTHER_ORG_ID, name: 'Other', handle: OTHER_ORG_ID, plan: 'free', managed_by: 'console' });
    const denied = await app.request(`/api/v2/projects?org_id=${OTHER_ORG_ID}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project: { name: 'nope' } }),
    });
    expect(denied.status).toBe(404);
  });
});

describe('request boundaries', () => {
  it('rejects a key name longer than 64 characters', async () => {
    const response = await app.request('/api/v2/api_keys', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key_name: 'x'.repeat(65) }),
    });
    expect(response.status).toBe(400);
  });

  it('404s a non-integer key id', async () => {
    expect((await app.request('/api/v2/api_keys/not-a-number', { method: 'DELETE' })).status).toBe(404);
  });
});

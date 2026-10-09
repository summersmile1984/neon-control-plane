import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { openDatabase } from '../../src/store/db.ts';
import { createRepositories, type Repositories } from '../../src/store/repo.ts';
import { createService } from '../../src/service.ts';
import { createApp, type AppEnv } from '../../src/http/app.ts';
import { configureRespond } from '../../src/http/respond.ts';
import { createReconciler, type Reconciler } from '../../src/reconciler/loop.ts';
import { createComputeSigner } from '../../src/domain/compute-auth.ts';
import { generateApiKey, hashApiKey } from '../../src/http/auth.ts';
import { nullLogger } from '../../src/logger.ts';
import type { Config } from '../../src/config.ts';
import { fakeAdapters, type FakeAdapters } from '../support/fakes.ts';
import { authed, bootstrapForTest, testIdentity, TEST_ORG_ID, TEST_OWNER_ID } from '../support/identity.ts';

/**
 * The identity and API-key management surface (design 004). Response validation is on, so every
 * assertion is also a schema assertion against the vendored official OpenAPI.
 */

configureRespond({ validate: true });

let repos: Repositories;
let app: Hono<AppEnv>;
let rawApp: Hono<AppEnv>;
let reconciler: Reconciler;
let fakes: FakeAdapters;

function makeConfig(): Config {
  return {
    port: 0, dbPath: ':memory:', masterKey: randomBytes(32),
    pageserverUrl: 'http://pageserver.invalid', pageserverConnstring: 'host=pageserver port=6400',
    safekeepers: ['safekeeper1:5454'], neonTag: 'test', computeImageRepo: 'docker.io/neondatabase',
    dockerSocket: '/var/run/docker.sock', dockerNetwork: 'neon-cp-test',
    computeVolumeRoot: '/tmp/neon-cp-identity', portRange: [55500, 55520],
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
  fakes = fakeAdapters();
  const service = createService({ repos, pageserver: fakes.pageserver, config, logger: nullLogger });
  reconciler = createReconciler({
    repos, pageserver: fakes.pageserver, docker: fakes.docker, compute: fakes.compute,
    signer: createComputeSigner('test'), config, logger: nullLogger,
  });
  rawApp = createApp({ repos, service, config, logger: nullLogger, reconciler });
  app = authed(rawApp);
});

afterEach(() => undefined);

async function createProject(name: string, key?: string): Promise<string> {
  const response = await (key ? authed(rawApp, key) : app).request('/api/v2/projects', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project: { name } }),
  });
  expect(response.status, await response.clone().text()).toBe(201);
  return ((await response.json()) as { project: { id: string } }).project.id;
}

describe('unauthenticated access', () => {
  it('rejects /api/v2 without a credential even when keys exist', async () => {
    expect((await rawApp.request('/api/v2/projects')).status).toBe(401);
    expect((await rawApp.request('/api/v2/projects', { headers: { authorization: 'Bearer nope' } })).status).toBe(401);
  });
});

describe('identity', () => {
  it('reports auth details, the current user and their organizations', async () => {
    const auth = await json(await app.request('/api/v2/auth'));
    expect(auth).toMatchObject({ auth_method: 'api_key_user', account_id: TEST_OWNER_ID });

    const me = await json(await app.request('/api/v2/users/me'));
    expect(me).toMatchObject({ id: TEST_OWNER_ID, email: 'owner@test.local' });

    const orgs = await json(await app.request('/api/v2/users/me/organizations'));
    expect((orgs.organizations as Array<Record<string, unknown>>).map((org) => org.id)).toEqual([TEST_ORG_ID]);

    const org = await json(await app.request(`/api/v2/organizations/${TEST_ORG_ID}`));
    expect(org).toMatchObject({ id: TEST_ORG_ID, plan: 'free' });
  });

  it('lists members with the member and user shape', async () => {
    const body = await json(await app.request(`/api/v2/organizations/${TEST_ORG_ID}/members`));
    const members = body.members as Array<Record<string, unknown>>;
    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({ member: { role: 'admin', user_id: TEST_OWNER_ID }, user: { email: 'owner@test.local' } });
  });
});

describe('personal API keys', () => {
  it('creates a key (token shown once), lists it without the token, then revokes it', async () => {
    const initial = (await (await app.request('/api/v2/api_keys')).json()) as unknown as Array<Record<string, unknown>>;
    // The bootstrap key seeded at startup is the only personal key so far.
    expect(initial).toHaveLength(1);

    const created = await json(await app.request('/api/v2/api_keys', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key_name: 'ci' }),
    }));
    const token = created.key as string;
    expect(token.startsWith('napi_')).toBe(true);
    expect(created).toMatchObject({ name: 'ci', created_by: TEST_OWNER_ID });

    const listed = (await json(await app.request('/api/v2/api_keys'))) as unknown as Array<Record<string, unknown>>;
    expect(listed).toHaveLength(2);
    const row = listed.find((entry) => entry.id === created.id)!;
    expect(row).toMatchObject({ name: 'ci' });
    expect(row.key).toBeUndefined();
    expect((row.created_by as Record<string, unknown>).id).toBe(TEST_OWNER_ID);

    // The new key works.
    expect((await authed(rawApp, token).request('/api/v2/projects')).status).toBe(200);

    const revoked = await json(await app.request(`/api/v2/api_keys/${created.id}`, { method: 'DELETE' }));
    expect(revoked).toMatchObject({ id: created.id, revoked: true });

    expect((await authed(rawApp, token).request('/api/v2/projects')).status).toBe(401);
    const after = (await (await app.request('/api/v2/api_keys')).json()) as unknown as Array<Record<string, unknown>>;
    expect(after.map((entry) => entry.id)).not.toContain(created.id);
  });
});

describe('organization and project-scoped API keys', () => {
  it('creates an org key as admin and confines a project-scoped key to that project', async () => {
    const p1 = await createProject('scoped-one');
    const p2 = await createProject('scoped-two');

    const orgKey = await json(await app.request(`/api/v2/organizations/${TEST_ORG_ID}/api_keys`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key_name: 'org' }),
    }));
    expect(String(orgKey.key).startsWith('napi_')).toBe(true);

    const scoped = await json(await app.request(`/api/v2/organizations/${TEST_ORG_ID}/api_keys`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key_name: 'scoped', project_id: p1 }),
    }));
    const scopedApp = authed(rawApp, scoped.key as string);

    expect((await scopedApp.request(`/api/v2/projects/${p1}`)).status).toBe(200);
    expect((await scopedApp.request(`/api/v2/projects/${p2}`)).status).toBe(404);

    const list = await json(await scopedApp.request('/api/v2/projects'));
    expect((list.projects as Array<Record<string, unknown>>).map((project) => project.id)).toEqual([p1]);
  });

  it('refuses organization key creation to a non-admin member', async () => {
    const memberKey = generateApiKey();
    repos.users.insert({ id: '00000000-0000-0000-0000-0000000000bb', email: 'viewer@test.local', name: 'Viewer', last_name: '', image: '', password_hash: null });
    repos.members.insert({ id: '00000000-0000-0000-0000-0000000000cc', org_id: TEST_ORG_ID, user_id: '00000000-0000-0000-0000-0000000000bb', role: 'viewer' });
    repos.apiKeys.insert({ name: 'viewer', key_hash: hashApiKey(memberKey), created_by: '00000000-0000-0000-0000-0000000000bb', kind: 'user' });

    const response = await authed(rawApp, memberKey).request(`/api/v2/organizations/${TEST_ORG_ID}/api_keys`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key_name: 'nope' }),
    });
    expect(response.status).toBe(403);

    // But the viewer can still manage their own personal keys.
    const personal = await authed(rawApp, memberKey).request('/api/v2/api_keys', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key_name: 'mine' }),
    });
    expect(personal.status, await personal.clone().text()).toBe(200);
  });
});

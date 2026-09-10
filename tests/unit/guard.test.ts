import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/store/db.ts';
import { createRepositories, type Repositories } from '../../src/store/repo.ts';
import { principalOrgIds, requireOrgAdmin, resolveActingOrg } from '../../src/http/guard.ts';
import { canManageOrgKeys, type Principal } from '../../src/domain/identity.ts';
import { ApiError } from '../../src/http/errors.ts';
import type { Config } from '../../src/config.ts';
import { bootstrapForTest, testIdentity, TEST_ORG_ID, TEST_OWNER_ID } from '../support/identity.ts';

const OTHER_ORG = 'org-other-000000000001';

function setup(): { repos: Repositories; config: Config } {
  const identity = testIdentity();
  const config = {
    port: 0, dbPath: ':memory:', masterKey: randomBytes(32),
    pageserverUrl: 'http://x', pageserverConnstring: 'host=x port=1',
    safekeepers: [], neonTag: 't', computeImageRepo: 'x', dockerSocket: '/x', dockerNetwork: 'x',
    computeVolumeRoot: '/x', portRange: [1, 2] as [number, number], routeMode: 'proxy' as const,
    zone: 'db.x', proxyToken: undefined, validateResponses: true, identity,
  } satisfies Config;
  const repos = createRepositories(openDatabase(':memory:'));
  bootstrapForTest(repos, identity);
  repos.organizations.insert({ id: OTHER_ORG, name: 'Other', handle: OTHER_ORG, plan: 'free', managed_by: 'console' });
  return { repos, config };
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return error instanceof ApiError ? error.code : `unexpected:${String(error)}`;
  }
  return 'no-throw';
}

describe('principalOrgIds', () => {
  it('lists the user orgs for a personal key and the bound org for an org key', () => {
    const { repos, config } = setup();
    const user: Principal = { kind: 'user_key', userId: TEST_OWNER_ID };
    expect(principalOrgIds(repos, user, config)).toEqual([TEST_ORG_ID]);
    const org: Principal = { kind: 'org_key', orgId: TEST_ORG_ID };
    expect(principalOrgIds(repos, org, config)).toEqual([TEST_ORG_ID]);
    expect(principalOrgIds(repos, { kind: 'org_key' }, config)).toEqual([]);
  });
});

describe('resolveActingOrg', () => {
  it('defaults a personal key to its org and honors a matching org_id', () => {
    const { repos, config } = setup();
    const user: Principal = { kind: 'user_key', userId: TEST_OWNER_ID };
    expect(resolveActingOrg(repos, config, user)).toBe(TEST_ORG_ID);
    expect(resolveActingOrg(repos, config, user, TEST_ORG_ID)).toBe(TEST_ORG_ID);
  });

  it('refuses an organization the user is not a member of', () => {
    const { repos, config } = setup();
    const user: Principal = { kind: 'user_key', userId: TEST_OWNER_ID };
    expect(codeOf(() => resolveActingOrg(repos, config, user, OTHER_ORG))).toBe('ORG_NOT_FOUND');
  });

  it('pins an org key to its own organization', () => {
    const { repos, config } = setup();
    const org: Principal = { kind: 'org_key', orgId: TEST_ORG_ID };
    expect(resolveActingOrg(repos, config, org)).toBe(TEST_ORG_ID);
    expect(codeOf(() => resolveActingOrg(repos, config, org, OTHER_ORG))).toBe('ORG_NOT_FOUND');
  });

  it('refuses a project-scoped key on organization actions', () => {
    const { repos, config } = setup();
    const scoped: Principal = { kind: 'org_key', orgId: TEST_ORG_ID, projectId: 'p1' };
    expect(codeOf(() => resolveActingOrg(repos, config, scoped))).toBe('FORBIDDEN');
  });
});

describe('requireOrgAdmin', () => {
  it('accepts an admin and rejects a viewer', () => {
    const { repos } = setup();
    repos.users.insert({ id: 'u2', email: 'v@x', name: 'V', last_name: '', image: '', password_hash: null });
    repos.members.insert({ id: 'm2', org_id: TEST_ORG_ID, user_id: 'u2', role: 'viewer' });

    expect(requireOrgAdmin(repos, { kind: 'user_key', userId: TEST_OWNER_ID }, TEST_ORG_ID).role).toBe('admin');
    expect(codeOf(() => requireOrgAdmin(repos, { kind: 'user_key', userId: 'u2' }, TEST_ORG_ID))).toBe('FORBIDDEN');
    expect(canManageOrgKeys('editor')).toBe(false);
    expect(canManageOrgKeys('admin')).toBe(true);
  });
});

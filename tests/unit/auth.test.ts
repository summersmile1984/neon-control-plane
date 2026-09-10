import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/store/db.ts';
import { createRepositories } from '../../src/store/repo.ts';
import { API_KEY_PREFIX, clientAddress, generateApiKey, hashApiKey, resolvePrincipal } from '../../src/http/auth.ts';
import { createSession } from '../../src/domain/session.ts';
import { bootstrapForTest, testIdentity, TEST_API_KEY, TEST_ORG_ID, TEST_OWNER_ID } from '../support/identity.ts';

function seeded() {
  const repos = createRepositories(openDatabase(':memory:'));
  bootstrapForTest(repos, testIdentity());
  return repos;
}

describe('API keys', () => {
  it('generates prefixed keys and hashes them stably', () => {
    const key = generateApiKey();
    expect(key.startsWith(API_KEY_PREFIX)).toBe(true);
    expect(hashApiKey(key)).toBe(hashApiKey(key));
    expect(hashApiKey(key)).toHaveLength(64);
    expect(hashApiKey(key)).not.toBe(hashApiKey(generateApiKey()));
  });

  it('supports a configurable prefix', () => {
    expect(generateApiKey('cp_').startsWith('cp_')).toBe(true);
  });

  it('resolves a personal key and records where it was last used', () => {
    const repos = seeded();
    const principal = resolvePrincipal(repos, { authorization: `Bearer ${TEST_API_KEY}`, address: '192.0.2.9' });
    expect(principal).toMatchObject({ kind: 'user_key', userId: TEST_OWNER_ID });

    const row = repos.apiKeys.findByHash(hashApiKey(TEST_API_KEY));
    expect(row?.last_used_at).toBeTruthy();
    expect(row?.last_used_from_addr).toBe('192.0.2.9');
  });

  it('resolves an organization key to its scope', () => {
    const repos = seeded();
    const key = generateApiKey();
    repos.apiKeys.insert({ name: 'org', key_hash: hashApiKey(key), kind: 'org', org_id: TEST_ORG_ID, project_id: 'p1' });
    expect(resolvePrincipal(repos, { authorization: `Bearer ${key}` })).toMatchObject({
      kind: 'org_key', orgId: TEST_ORG_ID, projectId: 'p1',
    });
  });

  it('resolves a console session cookie', () => {
    const repos = seeded();
    const { token } = createSession(repos, TEST_OWNER_ID, 60);
    expect(resolvePrincipal(repos, { cookieToken: token })).toMatchObject({ kind: 'session', userId: TEST_OWNER_ID });
  });

  it('returns no principal for a missing or wrong credential', () => {
    const repos = seeded();
    expect(resolvePrincipal(repos, {})).toBeUndefined();
    expect(resolvePrincipal(repos, { authorization: 'Bearer wrong' })).toBeUndefined();
  });

  it('rejects a revoked key', () => {
    const repos = seeded();
    const row = repos.apiKeys.findByHash(hashApiKey(TEST_API_KEY))!;
    repos.apiKeys.revoke(row.id);
    expect(resolvePrincipal(repos, { authorization: `Bearer ${TEST_API_KEY}` })).toBeUndefined();
  });
});

describe('clientAddress', () => {
  it('reads the first forwarded hop, then x-real-ip, else nothing', () => {
    expect(clientAddress(new Headers({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1' }))).toBe('203.0.113.7');
    expect(clientAddress(new Headers({ 'x-real-ip': '198.51.100.2' }))).toBe('198.51.100.2');
    expect(clientAddress(new Headers())).toBeUndefined();
  });
});

import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/store/db.ts';
import { createRepositories } from '../../src/store/repo.ts';
import { bootstrapIdentity } from '../../src/domain/bootstrap.ts';
import { hashApiKey } from '../../src/http/auth.ts';
import { verifyPassword } from '../../src/domain/session.ts';
import { nullLogger } from '../../src/logger.ts';
import { testIdentity, TEST_OWNER_ID, TEST_ORG_ID } from '../support/identity.ts';

function fresh() {
  return createRepositories(openDatabase(':memory:'));
}

describe('bootstrap identity', () => {
  it('seeds one owner, one admin membership and one key', () => {
    const repos = fresh();
    const identity = testIdentity();
    bootstrapIdentity(repos, identity, nullLogger);

    expect(repos.users.count()).toBe(1);
    expect(repos.organizations.count()).toBe(1);
    expect(repos.members.count()).toBe(1);
    expect(repos.apiKeys.count()).toBe(1);
    expect(repos.members.getByUserAndOrg(TEST_OWNER_ID, TEST_ORG_ID)?.role).toBe('admin');
    expect(repos.apiKeys.findByHash(hashApiKey(identity.bootstrapApiKey!))).toBeDefined();
  });

  it('is idempotent: a second run changes nothing', () => {
    const repos = fresh();
    const identity = testIdentity();
    bootstrapIdentity(repos, identity, nullLogger);
    const createdAt = repos.apiKeys.findByHash(hashApiKey(identity.bootstrapApiKey!))!.created_at;
    bootstrapIdentity(repos, identity, nullLogger);

    expect(repos.users.count()).toBe(1);
    expect(repos.members.count()).toBe(1);
    expect(repos.apiKeys.count()).toBe(1);
    expect(repos.apiKeys.findByHash(hashApiKey(identity.bootstrapApiKey!))!.created_at).toBe(createdAt);
  });

  it('rotates the owner password in place on a later run', () => {
    const repos = fresh();
    bootstrapIdentity(repos, testIdentity({ ownerPassword: 'first' }), nullLogger);
    bootstrapIdentity(repos, testIdentity({ ownerPassword: 'second' }), nullLogger);

    const owner = repos.users.get(TEST_OWNER_ID)!;
    expect(verifyPassword('second', owner.password_hash)).toBe(true);
    expect(verifyPassword('first', owner.password_hash)).toBe(false);
    expect(repos.users.count()).toBe(1);
  });

  it('seeds no key when no bootstrap key is configured', () => {
    const repos = fresh();
    bootstrapIdentity(repos, testIdentity({ bootstrapApiKey: undefined }), nullLogger);
    expect(repos.apiKeys.count()).toBe(0);
    expect(repos.users.count()).toBe(1);
  });
});

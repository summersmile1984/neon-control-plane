import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/store/db.ts';
import { createRepositories } from '../../src/store/repo.ts';
import {
  SESSION_COOKIE, createSession, destroySession, hashPassword, readSession, sessionId, verifyPassword,
} from '../../src/domain/session.ts';
import { bootstrapForTest, testIdentity, TEST_OWNER_ID } from '../support/identity.ts';

function repos() {
  const value = createRepositories(openDatabase(':memory:'));
  bootstrapForTest(value, testIdentity());
  return value;
}

describe('sessions', () => {
  it('issues an opaque token, stores only its hash, and resolves it', () => {
    const db = repos();
    const { token } = createSession(db, TEST_OWNER_ID, 60);
    expect(token).not.toContain('=');
    expect(db.sessions.get(sessionId(token))?.user_id).toBe(TEST_OWNER_ID);
    expect(db.sessions.get(token)).toBeUndefined(); // raw token is never the primary key
    expect(readSession(db, token)).toBe(TEST_OWNER_ID);
    expect(readSession(db, 'nope')).toBeUndefined();
  });

  it('treats an expired session as gone and deletes it', () => {
    const db = repos();
    const { token } = createSession(db, TEST_OWNER_ID, -1);
    expect(readSession(db, token)).toBeUndefined();
    expect(db.sessions.get(sessionId(token))).toBeUndefined();
  });

  it('destroys a session on logout', () => {
    const db = repos();
    const { token } = createSession(db, TEST_OWNER_ID, 60);
    destroySession(db, token);
    expect(readSession(db, token)).toBeUndefined();
  });

  it('names the cookie the spec declares', () => {
    expect(SESSION_COOKIE).toBe('zenith');
  });
});

describe('password hashing', () => {
  it('verifies the right password and rejects everything else', () => {
    const stored = hashPassword('correct horse');
    expect(verifyPassword('correct horse', stored)).toBe(true);
    expect(verifyPassword('wrong', stored)).toBe(false);
    expect(verifyPassword('correct horse', null)).toBe(false);
    expect(verifyPassword('correct horse', 'not-a-hash')).toBe(false);
    expect(verifyPassword('correct horse', 'scrypt$0$aa$bb')).toBe(false);
  });

  it('salts each hash so two hashes of the same password differ', () => {
    expect(hashPassword('same')).not.toBe(hashPassword('same'));
  });
});

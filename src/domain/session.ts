import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Repositories } from '../store/repo.ts';

/**
 * Console sessions and local password storage (design 004).
 *
 * The official console authenticates browsers with a Keycloak cookie. A local control plane runs no
 * IdP, so it issues its own opaque session into the same cookie name the spec's `CookieAuth` declares
 * (`zenith`). The raw token never touches the database: only its sha256 is stored, keyed by `sessions.id`.
 */

export const SESSION_COOKIE = 'zenith';

export function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function sessionId(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function createSession(repos: Repositories, userId: string, ttlSeconds: number): { token: string; expiresAt: string } {
  const token = newSessionToken();
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  repos.sessions.insert({ id: sessionId(token), user_id: userId, expires_at: expiresAt });
  return { token, expiresAt };
}

/** Returns the user id for a live session, touches it, or `undefined` when unknown/expired. */
export function readSession(repos: Repositories, token: string): string | undefined {
  const row = repos.sessions.get(sessionId(token));
  if (!row) return undefined;
  if (Date.parse(row.expires_at) <= Date.now()) {
    repos.sessions.remove(row.id);
    return undefined;
  }
  repos.sessions.touch(row.id);
  return row.user_id;
}

export function destroySession(repos: Repositories, token: string): void {
  repos.sessions.remove(sessionId(token));
}

// --- password hashing (scrypt) ---------------------------------------------------------------
const SCRYPT_N = 16_384;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, 32, { N: SCRYPT_N });
  return `scrypt$${SCRYPT_N}$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

export function verifyPassword(password: string, stored: string | null): boolean {
  if (!stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'scrypt') return false;
  const cost = Number(parts[1]);
  const salt = Buffer.from(parts[2]!, 'base64url');
  const expected = Buffer.from(parts[3]!, 'base64url');
  if (!Number.isInteger(cost) || cost <= 0) return false;
  const derived = scryptSync(password, salt, expected.length, { N: cost });
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

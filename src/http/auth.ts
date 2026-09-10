import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import type { Repositories } from '../store/repo.ts';
import type { Principal } from '../domain/identity.ts';
import { SESSION_COOKIE, readSession } from '../domain/session.ts';
import type { AppEnv } from './env.ts';
import { errors } from './errors.ts';

/**
 * Bearer API keys and console sessions (002 §4, T-111; extended by design 004).
 *
 * Keys are stored as sha256 hashes; the plaintext is shown once, when it is created. Every request
 * to `/api/v2` must present either a key or a session cookie — a fresh install is seeded at startup
 * with an owner and (when configured) a first key, so there is no anonymous window.
 */

export const DEFAULT_KEY_PREFIX = 'napi_';
/** Retained for callers that predate config-driven prefixes. */
export const API_KEY_PREFIX = DEFAULT_KEY_PREFIX;

export function generateApiKey(prefix: string = DEFAULT_KEY_PREFIX): string {
  return `${prefix}${randomBytes(24).toString('base64url')}`;
}

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

function equal(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Best-effort client address for `last_used_from_addr`; undefined behind a plain socket. */
export function clientAddress(headers: Headers): string | undefined {
  const forwarded = headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]!.trim();
  return headers.get('x-real-ip')?.trim() || undefined;
}

/**
 * Resolves a request credential to a principal. Touches the key's `last_used_at`/address on success.
 * Returns `undefined` when no valid credential is present.
 */
export function resolvePrincipal(
  repos: Repositories,
  input: { authorization?: string | null | undefined; cookieToken?: string | null | undefined; address?: string | undefined },
): Principal | undefined {
  const header = input.authorization ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (match) {
    const presented = hashApiKey(match[1]!.trim());
    const row = repos.apiKeys.findByHash(presented);
    if (row && equal(row.key_hash, presented)) {
      repos.apiKeys.touch(row.id, input.address);
      if (row.kind === 'org') {
        return {
          kind: 'org_key',
          keyId: row.id,
          ...(row.org_id ? { orgId: row.org_id } : {}),
          ...(row.project_id ? { projectId: row.project_id } : {}),
        };
      }
      if (row.created_by) return { kind: 'user_key', keyId: row.id, userId: row.created_by };
    }
    return undefined;
  }
  if (input.cookieToken) {
    const userId = readSession(repos, input.cookieToken);
    if (userId) return { kind: 'session', userId };
  }
  return undefined;
}

/**
 * The gate on `/api/v2`. Always requires a credential and stores the principal on the context for
 * the scope guards that run after it.
 */
export function apiAuth(repos: Repositories): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const address = clientAddress(c.req.raw.headers);
    const principal = resolvePrincipal(repos, {
      authorization: c.req.header('authorization'),
      cookieToken: getCookie(c, SESSION_COOKIE) ?? null,
      ...(address === undefined ? {} : { address }),
    });
    if (!principal) throw errors.unauthorized();
    c.set('principal', principal);
    if (principal.keyId !== undefined) c.set('apiKeyId', principal.keyId);
    return next();
  };
}

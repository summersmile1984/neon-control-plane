import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import type { Repositories } from '../store/repo.ts';
import { errors } from './errors.ts';

/**
 * Bearer API keys (002 §4, T-111). Keys are stored as sha256 hashes; the plaintext is shown once,
 * when it is created.
 *
 * When the table is empty the control plane runs open — a fresh local install is usable before
 * `scripts/create-api-key.mjs` has been run — and logs a warning on every request.
 */

export const API_KEY_PREFIX = 'neon_cp_';

export function generateApiKey(): string {
  return `${API_KEY_PREFIX}${randomBytes(24).toString('base64url')}`;
}

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

function equal(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

export function bearerAuth(repos: Repositories, onOpen?: () => void): MiddlewareHandler {
  return async (c, next) => {
    if (repos.apiKeys.count() === 0) {
      onOpen?.();
      return next();
    }
    const header = c.req.header('authorization') ?? '';
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (!match) throw errors.unauthorized();
    const presented = hashApiKey(match[1]!.trim());
    const row = repos.apiKeys.findByHash(presented);
    if (!row || !equal(row.key_hash, presented)) throw errors.unauthorized();
    repos.apiKeys.touch(row.id);
    c.set('apiKeyId', row.id);
    return next();
  };
}

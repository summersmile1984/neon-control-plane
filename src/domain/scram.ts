import { createHash, createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * SCRAM-SHA-256 verifier in PostgreSQL's `pg_authid.rolpassword` format (002 §9):
 *
 *   SCRAM-SHA-256$<iterations>:<base64 salt>$<base64 StoredKey>:<base64 ServerKey>
 *
 * The same string is written into the compute spec as `Role.encrypted_password` and handed to the
 * Neon proxy as `role_secret`. RFC 5802 §3:
 *   SaltedPassword = Hi(Normalize(password), salt, i)
 *   ClientKey      = HMAC(SaltedPassword, "Client Key")
 *   StoredKey      = H(ClientKey)
 *   ServerKey      = HMAC(SaltedPassword, "Server Key")
 */

export const SCRAM_DEFAULT_ITERATIONS = 4096;
const SALT_BYTES = 16;
const KEY_BYTES = 32;

export interface ScramParts {
  readonly iterations: number;
  readonly salt: Uint8Array;
  readonly storedKey: Uint8Array;
  readonly serverKey: Uint8Array;
}

export function scramParts(password: string, iterations = SCRAM_DEFAULT_ITERATIONS, salt: Uint8Array = randomBytes(SALT_BYTES)): ScramParts {
  if (!Number.isInteger(iterations) || iterations < 1) throw new Error('scram: iterations must be a positive integer');
  // PostgreSQL applies SASLprep; ASCII passwords (what this control plane generates) are unchanged.
  const saltedPassword = pbkdf2Sync(Buffer.from(password, 'utf8'), salt, iterations, KEY_BYTES, 'sha256');
  const clientKey = createHmac('sha256', saltedPassword).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', saltedPassword).update('Server Key').digest();
  return { iterations, salt, storedKey, serverKey };
}

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');

export function formatScramSecret(parts: ScramParts): string {
  return ['SCRAM-SHA-256$', parts.iterations, ':', b64(parts.salt), '$', b64(parts.storedKey), ':', b64(parts.serverKey)].join('');
}

/** Convenience: password -> PostgreSQL verifier string. */
export function scramSha256(password: string, iterations = SCRAM_DEFAULT_ITERATIONS, salt?: Uint8Array): string {
  return formatScramSecret(scramParts(password, iterations, salt));
}

const SECRET_PATTERN = /^SCRAM-SHA-256\$(\d+):([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+):([A-Za-z0-9+/=]+)$/;

export function parseScramSecret(secret: string): ScramParts {
  const match = SECRET_PATTERN.exec(secret);
  if (!match) throw new Error('scram: malformed verifier');
  const [, iterations, salt, storedKey, serverKey] = match as unknown as [string, string, string, string, string];
  return {
    iterations: Number(iterations),
    salt: Buffer.from(salt, 'base64'),
    storedKey: Buffer.from(storedKey, 'base64'),
    serverKey: Buffer.from(serverKey, 'base64'),
  };
}

/** Verify a candidate password against a stored verifier (used by tests and by the local auth path). */
export function verifyScramPassword(password: string, secret: string): boolean {
  const stored = parseScramSecret(secret);
  const candidate = scramParts(password, stored.iterations, stored.salt);
  return candidate.storedKey.length === stored.storedKey.length
    && timingSafeEqual(Buffer.from(candidate.storedKey), Buffer.from(stored.storedKey));
}

/**
 * Role passwords handed back through `reveal_password` / create / reset. Base64url of 24 random
 * bytes: URL-safe so it can go straight into a connection URI without percent-encoding.
 */
export function generatePassword(bytes = 24): string {
  return randomBytes(bytes).toString('base64url');
}

import { generateKeyPairSync, createPrivateKey, randomUUID, sign, type KeyObject } from 'node:crypto';

/**
 * compute_ctl's external HTTP API (`/status`, `/configure`, `/terminate`, …) requires a bearer JWT
 * signed by a key whose public half the control plane put into the spec's `compute_ctl_config.jwks`
 * (measured 2026-09-07: without it every call answers `400 invalid authorization token`). This is
 * why the official docker-compose ships a `private-key.pem` next to the spec template.
 *
 * The control plane holds one Ed25519 signing key for the life of the process (or loaded from
 * CP_COMPUTE_SIGNING_KEY) and mints a short-lived token per request.
 */

export interface ComputeJwk {
  readonly use: 'sig';
  readonly key_ops: readonly ['verify'];
  readonly alg: 'EdDSA';
  readonly kid: string;
  readonly kty: 'OKP';
  readonly crv: 'Ed25519';
  readonly x: string;
}

export interface ComputeSigner {
  readonly kid: string;
  /** Goes into every compute spec as `compute_ctl_config.jwks`. */
  jwks(): { keys: ComputeJwk[] };
  /** `Authorization: Bearer <token>` for a compute API call. */
  /** `computeId` must equal the compute_ctl `--compute-id` value or the call is rejected. */
  token(computeId: string, ttlSeconds?: number): string;
  /** PKCS#8 PEM, so the key can be persisted and reloaded across restarts. */
  exportPrivateKey(): string;
}

const DEFAULT_TTL_SECONDS = 300;
const b64url = (value: object | string): string =>
  Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');

function signerFrom(privateKey: KeyObject, publicJwk: { crv?: string; x?: string }, kid: string): ComputeSigner {
  if (publicJwk.crv !== 'Ed25519' || typeof publicJwk.x !== 'string') {
    throw new Error('compute signing key must be Ed25519');
  }
  const jwk: ComputeJwk = {
    use: 'sig', key_ops: ['verify'], alg: 'EdDSA', kid, kty: 'OKP', crv: 'Ed25519', x: publicJwk.x,
  };
  return {
    kid,
    jwks: () => ({ keys: [jwk] }),
    token(computeId: string, ttlSeconds = DEFAULT_TTL_SECONDS) {
      const issuedAt = Math.floor(Date.now() / 1000);
      const header = b64url({ alg: 'EdDSA', typ: 'JWT', kid });
      const payload = b64url({
        sub: computeId,
        // compute_ctl matches this against its own --compute-id and rejects a token without it
        // (measured 2026-09-07: `missing compute_id in authorization token claims`).
        compute_id: computeId,
        iss: 'neon-control-plane',
        // compute_ctl deserialises `aud` as a sequence: a bare string fails with
        // `invalid type: string "compute", expected a sequence` (measured 2026-09-07).
        aud: ['compute'],
        iat: issuedAt,
        exp: issuedAt + ttlSeconds,
        jti: randomUUID(),
      });
      const signature = sign(null, Buffer.from(`${header}.${payload}`), privateKey).toString('base64url');
      return `${header}.${payload}.${signature}`;
    },
    exportPrivateKey: () => privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

export function createComputeSigner(kid = 'neon-cp-compute-v1'): ComputeSigner {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return signerFrom(privateKey, publicKey.export({ format: 'jwk' }) as { crv?: string; x?: string }, kid);
}

export function loadComputeSigner(pkcs8Pem: string, kid = 'neon-cp-compute-v1'): ComputeSigner {
  const privateKey = createPrivateKey(pkcs8Pem);
  // Node can derive the public JWK from a private Ed25519 key directly.
  const jwk = privateKey.export({ format: 'jwk' }) as { crv?: string; x?: string };
  return signerFrom(privateKey, jwk, kid);
}

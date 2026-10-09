import { parseMasterKey } from './domain/secrets.ts';
import type { RouteMode } from './domain/connection-uri.ts';

/** Optional generic OIDC console login (design 004). Configured only when an issuer is present. */
export interface OidcConfig {
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string | undefined;
  readonly redirectUri: string;
  readonly scopes: string;
}

/**
 * Identity/bootstrap material (design 004). The control plane always requires auth; a fresh install
 * seeds exactly one owner user in one organization and, if `CP_BOOTSTRAP_API_KEY` is set, a personal
 * key for it, so a client can authenticate without touching the database by hand.
 */
export interface IdentityConfig {
  readonly ownerId: string;
  readonly ownerEmail: string;
  readonly ownerName: string;
  readonly ownerLastName: string;
  readonly ownerPassword: string | undefined;
  readonly orgId: string;
  readonly orgName: string;
  readonly keyPrefix: string;
  readonly sessionTtlSeconds: number;
  readonly devLogin: boolean;
  readonly bootstrapApiKey: string | undefined;
  readonly oidc: OidcConfig | undefined;
}

/** Process configuration (002 §11). Fails fast: a bad value must not surface as a runtime 500. */
export interface Config {
  /** Explicit ownership namespace for startup orphan reclamation. Absent disables it. */
  readonly instanceId?: string;
  readonly port: number;
  readonly dbPath: string;
  readonly masterKey: Buffer;
  readonly pageserverUrl: string;
  readonly pageserverConnstring: string;
  readonly safekeepers: readonly string[];
  readonly neonTag: string;
  readonly computeImageRepo: string;
  readonly dockerSocket: string;
  readonly dockerNetwork: string;
  readonly computeVolumeRoot: string;
  readonly portRange: readonly [number, number];
  readonly routeMode: RouteMode;
  readonly zone: string;
  readonly proxyToken: string | undefined;
  readonly validateResponses: boolean;
  readonly identity: IdentityConfig;
}

type Env = Record<string, string | undefined>;

function required(env: Env, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function optional(env: Env, key: string, fallback: string): string {
  const value = env[key]?.trim();
  return value ? value : fallback;
}

function integer(env: Env, key: string, fallback: number): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${key} must be a non-negative integer`);
  return value;
}

function routeMode(value: string): RouteMode {
  if (value === 'direct' || value === 'sni-router' || value === 'proxy') return value;
  throw new Error('CP_ROUTE_MODE must be direct, sni-router or proxy');
}

/**
 * A libpq keyword connection string. Guards the classic .env trap: an unquoted value with a space
 * is truncated by the shell to `host=pageserver`, and the compute then hangs in `init`.
 */
function connstring(value: string): string {
  if (!/(^|\s)host=/.test(value) || !/(^|\s)port=\d+/.test(value)) {
    throw new Error('CP_PAGESERVER_CONNSTRING must contain host= and port= (quote it in .env: "host=pageserver port=6400")');
  }
  return value;
}

function portRange(value: string): [number, number] {
  const match = /^(\d+)-(\d+)$/.exec(value);
  if (!match) throw new Error('CP_PORT_RANGE must look like 55500-55700');
  const low = Number(match[1]);
  const high = Number(match[2]);
  if (low < 1024 || high > 65_535 || high <= low) throw new Error('CP_PORT_RANGE is out of range');
  return [low, high];
}

function boolean(env: Env, key: string, fallback: boolean): boolean {
  const raw = env[key]?.trim();
  if (raw === undefined || raw === '') return fallback;
  if (raw === '1' || raw.toLowerCase() === 'true') return true;
  if (raw === '0' || raw.toLowerCase() === 'false') return false;
  throw new Error(`${key} must be 0/1 or true/false`);
}

function loadIdentity(env: Env): IdentityConfig {
  const issuer = env.CP_OIDC_ISSUER?.trim();
  const oidc: OidcConfig | undefined = issuer
    ? {
      issuer: issuer.replace(/\/+$/, ''),
      clientId: required(env, 'CP_OIDC_CLIENT_ID'),
      clientSecret: env.CP_OIDC_CLIENT_SECRET?.trim() || undefined,
      redirectUri: optional(env, 'CP_OIDC_REDIRECT_URI', 'http://localhost:8080/console/oidc/callback'),
      scopes: optional(env, 'CP_OIDC_SCOPES', 'openid email profile'),
    }
    : undefined;

  return {
    ownerId: optional(env, 'CP_OWNER_ID', '00000000-0000-0000-0000-000000000001'),
    ownerEmail: optional(env, 'CP_OWNER_EMAIL', 'owner@neon.localhost'),
    ownerName: optional(env, 'CP_OWNER_NAME', 'Local Owner'),
    ownerLastName: optional(env, 'CP_OWNER_LAST_NAME', ''),
    ownerPassword: env.CP_OWNER_PASSWORD?.trim() || undefined,
    orgId: optional(env, 'CP_ORG_ID', 'org-local-000000000001'),
    orgName: optional(env, 'CP_ORG_NAME', 'Local Organization'),
    keyPrefix: optional(env, 'CP_KEY_PREFIX', 'napi_'),
    sessionTtlSeconds: integer(env, 'CP_SESSION_TTL_SECONDS', 60 * 60 * 24 * 30),
    devLogin: boolean(env, 'CP_DEV_LOGIN', false),
    bootstrapApiKey: env.CP_BOOTSTRAP_API_KEY?.trim() || undefined,
    oidc,
  };
}

export function loadConfig(env: Env = process.env): Config {
  const instanceId = env.CP_INSTANCE_ID?.trim();
  if (instanceId && !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(instanceId)) {
    throw new Error('CP_INSTANCE_ID must be a 1-64 character ownership identifier');
  }
  return {
    ...(instanceId ? { instanceId } : {}),
    port: integer(env, 'CP_PORT', 8080),
    dbPath: optional(env, 'CP_DB_PATH', './data/cp.sqlite'),
    masterKey: parseMasterKey(required(env, 'CP_MASTER_KEY')),
    pageserverUrl: optional(env, 'CP_PAGESERVER_URL', 'http://127.0.0.1:9898'),
    pageserverConnstring: connstring(optional(env, 'CP_PAGESERVER_CONNSTRING', 'host=pageserver port=6400')),
    safekeepers: optional(env, 'CP_SAFEKEEPERS', 'safekeeper1:5454').split(',').map((entry) => entry.trim()).filter(Boolean),
    neonTag: optional(env, 'CP_NEON_TAG', 'latest'),
    computeImageRepo: optional(env, 'CP_COMPUTE_IMAGE_REPO', 'docker.io/neondatabase'),
    dockerSocket: optional(env, 'CP_DOCKER_SOCKET', '/var/run/docker.sock'),
    dockerNetwork: optional(env, 'CP_DOCKER_NETWORK', 'neon-cp'),
    computeVolumeRoot: optional(env, 'CP_COMPUTE_VOLUME_ROOT', './data/computes'),
    portRange: portRange(optional(env, 'CP_PORT_RANGE', '55500-55700')),
    routeMode: routeMode(optional(env, 'CP_ROUTE_MODE', 'direct')),
    zone: optional(env, 'CP_ZONE', 'db.neon.localhost'),
    proxyToken: env.CP_PROXY_TOKEN?.trim() || undefined,
    validateResponses: optional(env, 'CP_VALIDATE_RESPONSES', '1') === '1',
    identity: loadIdentity(env),
  };
}

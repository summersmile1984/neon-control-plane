import { parseMasterKey } from './domain/secrets.ts';
import type { RouteMode } from './domain/connection-uri.ts';

/** Process configuration (002 §11). Fails fast: a bad value must not surface as a runtime 500. */
export interface Config {
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

export function loadConfig(env: Env = process.env): Config {
  return {
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
    zone: optional(env, 'CP_ZONE', 'db.siteops.localhost'),
    proxyToken: env.CP_PROXY_TOKEN?.trim() || undefined,
    validateResponses: optional(env, 'CP_VALIDATE_RESPONSES', '1') === '1',
  };
}

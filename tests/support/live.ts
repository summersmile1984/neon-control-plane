import { execFileSync } from 'node:child_process';
import { connect } from 'node:net';

/**
 * Helpers for the e2e tests that drive the *running* local stack rather than an in-process app:
 * `pnpm dev` on :8080 plus the compose `proxy` profile. Those tests exercise the deployed request
 * path, so they cannot build their own Hono instance — the proxy container has one control-plane
 * address baked into `--auth-endpoint`.
 *
 * Everything here reports a missing precondition as a skip reason, never an exception, so a
 * developer without the stack up sees "not run" rather than a wall of red.
 */

export const BASE = process.env.CP_BASE_URL ?? 'http://127.0.0.1:8080';
export const PROXY_PORT = Number(process.env.CP_PROXY_PORT ?? 5434);
export const ZONE = process.env.CP_ZONE ?? 'db.siteops.localhost';

const API_KEY = process.env.CP_API_KEY;
const headers = { 'content-type': 'application/json', ...(API_KEY ? { authorization: `Bearer ${API_KEY}` } : {}) };

export interface ConnectionParameters {
  readonly password: string;
  readonly role: string;
  readonly database: string;
  readonly host: string;
}

export interface CreatedProject {
  readonly projectId: string;
  readonly branchId: string;
  readonly endpointId: string;
  readonly connection: ConnectionParameters;
}

export async function api(path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
  const response = await fetch(`${BASE}/api/v2${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
  const body = (await response.json()) as Record<string, unknown>;
  if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${path} -> ${response.status} ${JSON.stringify(body)}`);
  return body;
}

function tcpOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port, timeout: 1500 })
      .on('connect', () => { socket.destroy(); resolve(true); })
      .on('error', () => resolve(false))
      .on('timeout', () => { socket.destroy(); resolve(false); });
  });
}

/** Returns a skip reason, or undefined when the live stack is ready to drive. */
export async function preflight(): Promise<string | undefined> {
  try {
    const mode = (await (await fetch(`${BASE}/readyz`)).json()) as { route_mode?: string };
    if (mode.route_mode !== 'proxy') return `control plane is in ${String(mode.route_mode)} mode; set CP_ROUTE_MODE=proxy`;
  } catch (error) {
    return `control plane at ${BASE}: ${(error as Error).message}`;
  }
  if (!(await tcpOpen(PROXY_PORT))) {
    return `no proxy on 127.0.0.1:${PROXY_PORT}; run PROXY_PORT=${PROXY_PORT} docker compose --profile proxy up -d proxy`;
  }
  try {
    execFileSync('psql', ['--version'], { stdio: 'ignore' });
  } catch {
    return 'psql is not on PATH';
  }
  return undefined;
}

export async function createProject(name: string): Promise<CreatedProject> {
  const created = await api('/projects', { method: 'POST', body: JSON.stringify({ project: { name, pg_version: 17 } }) });
  const parameters = (created.connection_uris as Array<{ connection_parameters: ConnectionParameters }>)[0]!.connection_parameters;
  return {
    projectId: (created.project as { id: string }).id,
    branchId: (created.branch as { id: string }).id,
    endpointId: (created.endpoints as Array<{ id: string }>)[0]!.id,
    connection: parameters,
  };
}

export async function settle(projectId: string, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const operations = (await api(`/projects/${projectId}/operations`)).operations as Array<{ status: string; action: string; error?: string }>;
    const failed = operations.filter((row) => row.status === 'failed');
    if (failed.length > 0) throw new Error(`operations failed: ${failed.map((row) => `${row.action}: ${row.error ?? ''}`).join(', ')}`);
    if (operations.every((row) => row.status === 'finished' || row.status === 'skipped')) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`operations for ${projectId} did not settle`);
}

/**
 * Polls a predicate. Deleting a project soft-deletes its row, so `/operations` starts returning
 * 404 and `settle` cannot be used to wait for a teardown — watch the effect instead.
 */
export async function waitFor(what: string, predicate: () => boolean | Promise<boolean>, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`timed out waiting for ${what}`);
}

export async function endpointState(projectId: string, endpointId: string): Promise<string> {
  return ((await api(`/projects/${projectId}/endpoints/${endpointId}`)).endpoint as { current_state: string }).current_state;
}

export interface PsqlOptions {
  /** `sni` puts the endpoint in the hostname; `options` puts it in the startup packet (no DNS). */
  readonly mode?: 'sni' | 'options';
  readonly role?: string;
  readonly password?: string;
  readonly database?: string;
}

/** Connects through the proxy and returns stdout, or `ERROR: <detail>` — never throws. */
export function psqlThroughProxy(endpointId: string, connection: ConnectionParameters, sql: string, options: PsqlOptions = {}): string {
  const role = options.role ?? connection.role;
  const database = options.database ?? connection.database;
  const target = options.mode === 'sni'
    ? `postgresql://${role}@${endpointId}.${ZONE}:${PROXY_PORT}/${database}?sslmode=require&channel_binding=require`
    : `postgresql://${role}@127.0.0.1:${PROXY_PORT}/${database}?sslmode=require&options=endpoint%3D${endpointId}`;
  try {
    return execFileSync('psql', [target, '-tAc', sql], {
      encoding: 'utf8',
      env: { ...process.env, PGPASSWORD: options.password ?? connection.password, PGCONNECT_TIMEOUT: '30' },
    }).trim();
  } catch (error) {
    const detail = (error as { stderr?: Buffer | string }).stderr;
    return `ERROR: ${String(detail ?? (error as Error).message).trim().slice(0, 300)}`;
  }
}

export function computeContainerRunning(endpointId: string): boolean {
  return execFileSync('docker', ['ps', '-q', '--filter', `name=${endpointId}`], { encoding: 'utf8' }).trim() !== '';
}

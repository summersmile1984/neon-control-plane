import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { openDatabase } from '../../src/store/db.ts';
import { createRepositories, type Repositories } from '../../src/store/repo.ts';
import { createService } from '../../src/service.ts';
import { createApp, type AppEnv } from '../../src/http/app.ts';
import { configureRespond } from '../../src/http/respond.ts';
import { createReconciler, type Reconciler } from '../../src/reconciler/loop.ts';
import { createComputeSigner } from '../../src/domain/compute-auth.ts';
import { createPageserverClient } from '../../src/adapters/pageserver.ts';
import { createDockerClient } from '../../src/adapters/docker.ts';
import { createComputeClient } from '../../src/adapters/compute.ts';
import { createLogger, nullLogger } from '../../src/logger.ts';
import type { Config } from '../../src/config.ts';
import { authed, bootstrapForTest, testIdentity } from '../support/identity.ts';

/**
 * The whole control plane against the real storage layer and real compute containers
 * (002 §12.3). Requires `pnpm compose:up`; skipped when the pageserver is not reachable.
 */

const PAGESERVER_URL = process.env.CP_PAGESERVER_URL ?? 'http://127.0.0.1:9898';
const workdir = mkdtempSync(join(tmpdir(), 'neon-cp-e2e-'));

let repos: Repositories;
let app: Hono<AppEnv>;
let reconciler: Reconciler;
let reachable = false;
const createdProjects: string[] = [];

const config: Config = {
  port: 0,
  dbPath: join(workdir, 'cp.sqlite'),
  masterKey: randomBytes(32),
  pageserverUrl: PAGESERVER_URL,
  pageserverConnstring: 'host=pageserver port=6400',
  safekeepers: ['safekeeper1:5454'],
  neonTag: process.env.NEON_TAG ?? 'latest',
  computeImageRepo: 'docker.io/neondatabase',
  dockerSocket: process.env.CP_DOCKER_SOCKET ?? '/var/run/docker.sock',
  dockerNetwork: 'neon-cp',
  computeVolumeRoot: join(workdir, 'computes'),
  portRange: [55700, 55760],
  // `direct` publishes the compute port on the host, which is what psql below connects to.
  routeMode: 'direct',
  zone: 'db.neon.localhost',
  proxyToken: undefined,
  validateResponses: true,
  identity: testIdentity(),
};

/** Runs psql inside the compute container: the image ships the client, the host may not. */
function psql(endpointId: string, sql: string, options: { user?: string; db?: string } = {}): string {
  try {
    return execFileSync('docker', [
      'exec', endpointId, 'psql', '-h', '127.0.0.1', '-p', '55433',
      '-U', options.user ?? 'cloud_admin', '-d', options.db ?? 'postgres', '-tAc', sql,
    ], { encoding: 'utf8' }).trim();
  } catch (error) {
    const detail = (error as { stderr?: Buffer | string }).stderr;
    return `ERROR: ${String(detail ?? (error as Error).message).slice(0, 300)}`;
  }
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

/** Runs the reconciler until every operation of a project is out of flight. */
async function settle(projectId: string, timeoutMs = 180_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await reconciler.drain(20);
    const pending = repos.operations.listByProject(projectId, 100).filter((row) => row.status === 'scheduling' || row.status === 'running');
    if (pending.length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`operations for ${projectId} did not settle`);
}

function failedOperations(projectId: string): string[] {
  return repos.operations.listByProject(projectId, 100)
    .filter((row) => row.status === 'failed')
    .map((row) => `${row.action}: ${row.error ?? 'no detail'}`);
}

beforeAll(async () => {
  configureRespond({ validate: true });
  const pageserver = createPageserverClient({ baseUrl: PAGESERVER_URL });
  try {
    await pageserver.status();
    reachable = true;
  } catch {
    reachable = false;
    return;
  }

  const docker = createDockerClient({ socketPath: config.dockerSocket });
  const signer = createComputeSigner('e2e');
  const compute = createComputeClient({ signer });
  repos = createRepositories(openDatabase(config.dbPath));
  bootstrapForTest(repos, config.identity);
  const logger = process.env.CP_E2E_LOGS ? createLogger('debug') : nullLogger;
  const service = createService({ repos, pageserver, config, logger });
  reconciler = createReconciler({ repos, pageserver, docker, compute, signer, config, logger });
  app = authed(createApp({ repos, service, config, logger, reconciler }));
}, 120_000);

afterAll(async () => {
  if (!reachable) return;
  for (const projectId of createdProjects) {
    try {
      await app.request(`/api/v2/projects/${projectId}`, { method: 'DELETE' });
      await settle(projectId, 60_000);
    } catch { /* best effort */ }
  }
  rmSync(workdir, { recursive: true, force: true });
}, 300_000);

beforeEach((context) => {
  if (!reachable) context.skip(`pageserver at ${PAGESERVER_URL} unreachable; run pnpm compose:up`);
});

describe('control plane against the real Neon storage and compute', () => {
  it('creates a project whose compute really serves Postgres', async () => {
    if (!reachable) return expect(reachable, `pageserver at ${PAGESERVER_URL} unreachable; run pnpm compose:up`).toBe(false);

    const created = await json(await app.request('/api/v2/projects', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project: { name: 'e2e', pg_version: 17 } }),
    }));
    const projectId = (created.project as Record<string, unknown>).id as string;
    createdProjects.push(projectId);
    const endpointId = ((created.endpoints as Array<Record<string, unknown>>)[0]!).id as string;

    await settle(projectId);
    expect(failedOperations(projectId)).toEqual([]);

    const endpoint = await json(await app.request(`/api/v2/projects/${projectId}/endpoints/${endpointId}`));
    expect((endpoint.endpoint as Record<string, unknown>).current_state).toBe('active');

    // The spec really produced the role and database the API reported.
    expect(psql(endpointId, 'select 1')).toBe('1');
    expect(psql(endpointId, "select datname from pg_database where datname = 'neondb'")).toBe('neondb');
    expect(psql(endpointId, "select rolname from pg_roles where rolname = 'neondb_owner'")).toBe('neondb_owner');
  }, 300_000);

  it('hands out a connection URI whose credentials actually authenticate', async () => {
    if (!reachable) return;
    const projectId = createdProjects[0]!;
    const uriBody = await json(await app.request(`/api/v2/projects/${projectId}/connection_uri?database_name=neondb&role_name=neondb_owner`));
    const uri = new URL(String(uriBody.uri));
    const endpointId = repos.endpoints.listByProject(projectId)[0]!.id;

    // SCRAM verifier written into the spec must match the password handed to the caller.
    const login = execFileSync('docker', [
      'exec', '-e', `PGPASSWORD=${decodeURIComponent(uri.password)}`, endpointId,
      'psql', '-h', '127.0.0.1', '-p', '55433', '-U', decodeURIComponent(uri.username), '-d', 'neondb', '-tAc', 'select current_user',
    ], { encoding: 'utf8' }).trim();
    expect(login).toBe('neondb_owner');
  }, 120_000);

  it('creates a role and a database, then removes the role through delta_operations', async () => {
    if (!reachable) return;
    const projectId = createdProjects[0]!;
    const branchId = repos.branches.listByProject(projectId)[0]!.id;
    const endpointId = repos.endpoints.listByProject(projectId)[0]!.id;

    const roleBody = await json(await app.request(`/api/v2/projects/${projectId}/branches/${branchId}/roles`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: { name: 'e2e_user' } }),
    }));
    const password = (roleBody.role as Record<string, unknown>).password as string;
    await settle(projectId);
    expect(failedOperations(projectId)).toEqual([]);
    expect(psql(endpointId, "select rolname from pg_roles where rolname = 'e2e_user'")).toBe('e2e_user');

    const databaseResponse = await app.request(`/api/v2/projects/${projectId}/branches/${branchId}/databases`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ database: { name: 'e2e_db', owner_name: 'e2e_user' } }),
    });
    expect(databaseResponse.status, await databaseResponse.clone().text()).toBe(201);
    await settle(projectId);
    expect(psql(endpointId, "select datname from pg_database where datname = 'e2e_db'")).toBe('e2e_db');

    // the new role can log in to the database it owns
    const login = execFileSync('docker', [
      'exec', '-e', `PGPASSWORD=${password}`, endpointId,
      'psql', '-h', '127.0.0.1', '-p', '55433', '-U', 'e2e_user', '-d', 'e2e_db', '-tAc', 'select current_user',
    ], { encoding: 'utf8' }).trim();
    expect(login).toBe('e2e_user');

    // deleting the database frees the role, then the role itself goes through delta_operations
    expect((await app.request(`/api/v2/projects/${projectId}/branches/${branchId}/databases/e2e_db`, { method: 'DELETE' })).status).toBe(200);
    await settle(projectId);
    expect(psql(endpointId, "select count(*) from pg_database where datname = 'e2e_db'")).toBe('0');

    expect((await app.request(`/api/v2/projects/${projectId}/branches/${branchId}/roles/e2e_user`, { method: 'DELETE' })).status).toBe(200);
    await settle(projectId);
    expect(failedOperations(projectId)).toEqual([]);
    expect(psql(endpointId, "select count(*) from pg_roles where rolname = 'e2e_user'")).toBe('0');
  }, 300_000);

  it('suspends and restarts a compute', async () => {
    if (!reachable) return;
    const projectId = createdProjects[0]!;
    const endpointId = repos.endpoints.listByProject(projectId)[0]!.id;

    expect((await app.request(`/api/v2/projects/${projectId}/endpoints/${endpointId}/suspend`, { method: 'POST' })).status).toBe(200);
    await settle(projectId);
    expect(repos.endpoints.get(endpointId)?.current_state).toBe('idle');

    expect((await app.request(`/api/v2/projects/${projectId}/endpoints/${endpointId}/start`, { method: 'POST' })).status).toBe(200);
    await settle(projectId);
    expect(repos.endpoints.get(endpointId)?.current_state).toBe('active');
    expect(psql(endpointId, 'select 1')).toBe('1');
  }, 300_000);

  it('branches at a point in time and the child sees only the earlier data', async () => {
    if (!reachable) return;
    const projectId = createdProjects[0]!;
    const branchId = repos.branches.listByProject(projectId)[0]!.id;
    const endpointId = repos.endpoints.listByProject(projectId)[0]!.id;

    expect(psql(endpointId, 'create table pitr_probe (id int)', { db: 'neondb' })).toBe('CREATE TABLE');
    expect(psql(endpointId, 'insert into pitr_probe values (1)', { db: 'neondb' })).toBe('INSERT 0 1');
    // Force the WAL out so the branch point is durable on the safekeeper.
    psql(endpointId, 'select pg_current_wal_flush_lsn()', { db: 'neondb' });
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const cutoff = new Date().toISOString();
    await new Promise((resolve) => setTimeout(resolve, 2000));
    expect(psql(endpointId, 'insert into pitr_probe values (2)', { db: 'neondb' })).toBe('INSERT 0 1');
    psql(endpointId, 'select pg_current_wal_flush_lsn()', { db: 'neondb' });

    const branchResponse = await app.request(`/api/v2/projects/${projectId}/branches`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        branch: { name: `pitr-${randomBytes(3).toString('hex')}`, parent_id: branchId, parent_timestamp: cutoff },
        endpoints: [{ type: 'read_write' }],
      }),
    });
    expect(branchResponse.status, await branchResponse.clone().text()).toBe(201);
    const branchBody = await json(branchResponse);
    const childEndpointId = ((branchBody.endpoints as Array<Record<string, unknown>>)[0]!).id as string;

    await settle(projectId);
    expect(failedOperations(projectId)).toEqual([]);

    const rows = psql(childEndpointId, 'select coalesce(string_agg(id::text, \',\' order by id), \'\') from pitr_probe', { db: 'neondb' });
    // The child branched before the second insert, so it must not see id = 2.
    expect(rows).toBe('1');
  }, 300_000);
});

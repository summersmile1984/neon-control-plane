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
import { nullLogger } from '../../src/logger.ts';
import type { Config } from '../../src/config.ts';
import { authed, bootstrapForTest, testIdentity } from '../support/identity.ts';

/**
 * The final-effect check: after the management API says a project exists, prove it on the data
 * plane. The API and the operations list can both look healthy while nothing materialised in the
 * Neon containers, so this asserts what is actually there:
 *
 *   storage   the project is a real pageserver tenant with a timeline
 *   compute   the database and role exist and authenticate
 *   SQL       DDL executes, DML mutates and reads back, a transaction rolls back
 *
 * Requires `pnpm compose:up`; skipped (not failed) when the pageserver is not reachable.
 */

const PAGESERVER_URL = process.env.CP_PAGESERVER_URL ?? 'http://127.0.0.1:9898';
const workdir = mkdtempSync(join(tmpdir(), 'neon-cp-dataplane-'));

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
  portRange: [55900, 55920],
  routeMode: 'direct',
  zone: 'db.siteops.localhost',
  proxyToken: undefined,
  validateResponses: true,
  identity: testIdentity(),
};

/** Runs psql inside the compute container; the image ships the client, the host may not. */
function psql(endpointId: string, sql: string, options: { user?: string; db?: string } = {}): string {
  try {
    return execFileSync('docker', [
      'exec', endpointId, 'psql', '-h', '127.0.0.1', '-p', '55433',
      '-U', options.user ?? 'cloud_admin', '-d', options.db ?? 'postgres', '-tAc', sql,
    ], { encoding: 'utf8' }).trim();
  } catch (error) {
    const detail = (error as { stderr?: Buffer | string }).stderr;
    return `ERROR: ${String(detail ?? (error as Error).message).trim().slice(0, 300)}`;
  }
}

/** Runs psql on the host against a full connection URI (direct mode publishes the compute port). */
function psqlUri(uri: string, sql: string): string {
  try {
    return execFileSync('psql', [uri, '-tAc', sql], { encoding: 'utf8' }).trim();
  } catch (error) {
    const detail = (error as { stderr?: Buffer | string }).stderr;
    return `ERROR: ${String(detail ?? (error as Error).message).trim().slice(0, 300)}`;
  }
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

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
  const signer = createComputeSigner('dataplane');
  const compute = createComputeClient({ signer });
  repos = createRepositories(openDatabase(config.dbPath));
  bootstrapForTest(repos, config.identity);
  const service = createService({ repos, pageserver, config, logger: nullLogger });
  reconciler = createReconciler({ repos, pageserver, docker, compute, signer, config, logger: nullLogger });
  app = authed(createApp({ repos, service, config, logger: nullLogger, reconciler }));

  const created = await json(await app.request('/api/v2/projects', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project: { name: 'data-plane', pg_version: 17 } }),
  }));
  createdProjects.push((created.project as { id: string }).id);
  await settle(createdProjects[0]!);
}, 300_000);

afterAll(async () => {
  if (!reachable) return;
  for (const projectId of createdProjects) {
    try {
      await app.request(`/api/v2/projects/${projectId}`, { method: 'DELETE' });
      // Nothing drains this in-process reconciler on a timer, so the delete would only queue the
      // tenant_detach operation and leave the compute container holding its published ports.
      await reconciler.drain();
    } catch { /* best effort */ }
  }
  rmSync(workdir, { recursive: true, force: true });
}, 300_000);

beforeEach((context) => {
  if (!reachable) context.skip(`pageserver at ${PAGESERVER_URL} unreachable; run pnpm compose:up`);
});

describe('the project really materialised on the data plane', () => {
  it('exists as a pageserver tenant with the branch timeline', async () => {
    const projectId = createdProjects[0]!;
    const project = repos.projects.get(projectId)!;
    const branch = repos.branches.listByProject(projectId)[0]!;

    const tenants = await (await fetch(`${PAGESERVER_URL}/v1/tenant`)).json() as Array<{ id: string }>;
    expect(tenants.map((row) => row.id)).toContain(project.tenant_id);

    const timelines = await (await fetch(`${PAGESERVER_URL}/v1/tenant/${project.tenant_id}/timeline`)).json() as Array<{ timeline_id: string }>;
    expect(timelines.map((row) => row.timeline_id)).toContain(branch.timeline_id);
  }, 60_000);

  it('has the database and role the API reported', () => {
    const endpointId = repos.endpoints.listByProject(createdProjects[0]!)[0]!.id;
    expect(psql(endpointId, 'select 1')).toBe('1');
    expect(psql(endpointId, "select datname from pg_database where datname = 'neondb'")).toBe('neondb');
    expect(psql(endpointId, "select rolname from pg_roles where rolname = 'neondb_owner'")).toBe('neondb_owner');
  }, 60_000);

  it('runs DDL: create table, create index, alter table', () => {
    const endpointId = repos.endpoints.listByProject(createdProjects[0]!)[0]!.id;
    const db = 'neondb';

    expect(psql(endpointId, 'drop table if exists dp_probe', { db })).toContain('DROP');
    expect(psql(endpointId, 'create table dp_probe (id int primary key, note text)', { db })).toBe('CREATE TABLE');
    expect(psql(endpointId, 'create index dp_probe_note_idx on dp_probe (note)', { db })).toBe('CREATE INDEX');
    expect(psql(endpointId, 'alter table dp_probe add column amount numeric(10,2)', { db })).toBe('ALTER TABLE');
    expect(psql(endpointId, "select count(*) from information_schema.columns where table_name = 'dp_probe'", { db })).toBe('3');
  }, 60_000);

  it('runs DML: insert, update, delete and reads the effects back', () => {
    const endpointId = repos.endpoints.listByProject(createdProjects[0]!)[0]!.id;
    const db = 'neondb';

    expect(psql(endpointId, "insert into dp_probe values (1, 'one', 10.5), (2, 'two', 20.0), (3, 'three', 30.25)", { db })).toBe('INSERT 0 3');
    expect(psql(endpointId, 'select count(*) from dp_probe', { db })).toBe('3');
    expect(psql(endpointId, "select sum(amount)::text from dp_probe", { db })).toBe('60.75');

    expect(psql(endpointId, "update dp_probe set note = 'TWO' where id = 2", { db })).toBe('UPDATE 1');
    expect(psql(endpointId, 'select note from dp_probe where id = 2', { db })).toBe('TWO');

    expect(psql(endpointId, 'delete from dp_probe where id = 1', { db })).toBe('DELETE 1');
    expect(psql(endpointId, 'select coalesce(string_agg(id::text, \',\' order by id), \'\') from dp_probe', { db })).toBe('2,3');
  }, 60_000);

  it('rolls a transaction back', () => {
    const endpointId = repos.endpoints.listByProject(createdProjects[0]!)[0]!.id;
    const db = 'neondb';

    psql(endpointId, "begin; insert into dp_probe values (99, 'ghost', 1); rollback", { db });
    expect(psql(endpointId, 'select count(*) from dp_probe where id = 99', { db })).toBe('0');
  }, 60_000);

  it('hands out a connection URI whose credentials actually authenticate', async () => {
    const projectId = createdProjects[0]!;
    const uriBody = await json(await app.request(`/api/v2/projects/${projectId}/connection_uri?database_name=neondb&role_name=neondb_owner`));
    const uri = String(uriBody.uri);
    expect(uri).toMatch(/^postgresql:\/\/neondb_owner:/);
    expect(psqlUri(uri, 'select current_user')).toBe('neondb_owner');
    expect(psqlUri(uri, 'select datname from pg_database where datname = current_database()')).toBe('neondb');
  }, 60_000);
});

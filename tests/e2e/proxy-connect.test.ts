import { execFileSync } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  api, computeContainerRunning, createProject, endpointState, preflight,
  psqlThroughProxy, PROXY_PORT, settle, ZONE, type CreatedProject,
} from '../support/live.ts';

/**
 * T-302: the official Neon proxy in front of the control plane.
 *
 *   psql --TLS-->  proxy :5432  --/cplane/get_endpoint_access_control-->  control plane :8080
 *                       |        --/cplane/wake_compute---------------->
 *                       '--------->  compute container :55433
 *
 * The proxy runs SCRAM itself against the verifier the control plane hands it, so a successful
 * login proves the whole chain, including that the plaintext password never left the control plane.
 *
 * Preconditions (skipped, not failed, when missing):
 *   - `pnpm compose:up` and `PROXY_PORT=5434 docker compose --profile proxy up -d proxy`
 *   - `pnpm dev` with CP_ROUTE_MODE=proxy and CP_PROXY_TOKEN matching the proxy container
 *   - psql on the host
 */

let project: CreatedProject | undefined;
let skipReason: string | undefined = 'not initialised';
/** The SNI case needs `<endpoint>.<zone>` to resolve; `*.localhost` does on macOS, not everywhere. */
let zoneResolves = false;

function sql(statement: string, options: Parameters<typeof psqlThroughProxy>[3] = {}): string {
  return psqlThroughProxy(project!.endpointId, project!.connection, statement, options);
}

beforeAll(async () => {
  skipReason = await preflight();
  if (skipReason) return;
  project = await createProject('e2e-proxy');
  await settle(project.projectId);
  zoneResolves = await lookup(`${project.endpointId}.${ZONE}`).then(() => true, () => false);
}, 180_000);

afterAll(async () => {
  if (project) await api(`/projects/${project.projectId}`, { method: 'DELETE' }).catch(() => undefined);
}, 120_000);

beforeEach((context) => {
  if (skipReason) context.skip(skipReason);
});

describe('psql through the official Neon proxy', () => {
  it('serves Postgres through the proxy, addressed by startup option', () => {
    if (skipReason) return expect(skipReason, skipReason).toBeUndefined();
    expect(sql('select version()')).toMatch(/^PostgreSQL 17\./);
    expect(sql('select current_user')).toBe(project!.connection.role);
    // 55433 is the compute's own port: the session really terminated on the compute container.
    expect(sql('select inet_server_port()')).toBe('55433');
  });

  it('serves Postgres through the proxy, addressed by SNI with channel binding required', () => {
    if (skipReason) return expect(skipReason, skipReason).toBeUndefined();
    if (!zoneResolves) return expect(zoneResolves, `${project!.endpointId}.${ZONE} does not resolve`).toBe(false);
    // channel_binding=require means psql refuses to authenticate unless the proxy offers
    // SCRAM-SHA-256-PLUS bound to its own certificate.
    expect(sql('select version()', { mode: 'sni' })).toMatch(/^PostgreSQL 17\./);
  });

  it('rejects a wrong password, proving the proxy runs SCRAM against the control plane verifier', () => {
    if (skipReason) return expect(skipReason, skipReason).toBeUndefined();
    const result = sql('select 1', { password: 'not-the-password' });
    expect(result).toMatch(/^ERROR:/);
    expect(result).toMatch(/password authentication failed|auth(entication)? failed/i);
  });

  it('wakes a suspended compute on connect and keeps the data written before the suspend', async () => {
    if (skipReason) return expect(skipReason, skipReason).toBeUndefined();
    const { projectId, endpointId } = project!;

    expect(sql('create table wake_probe(note text)')).toBe('CREATE TABLE');
    expect(sql("insert into wake_probe values ('before suspend')")).toBe('INSERT 0 1');

    await api(`/projects/${projectId}/endpoints/${endpointId}/suspend`, { method: 'POST' });
    await settle(projectId);
    expect(await endpointState(projectId, endpointId)).toBe('idle');
    // The container is gone, not merely paused: this is a real cold start.
    expect(computeContainerRunning(endpointId)).toBe(false);

    expect(sql('select note from wake_probe')).toBe('before suspend');
    expect(await endpointState(projectId, endpointId)).toBe('active');
  }, 180_000);

  it('fails an unknown endpoint with a message instead of hanging', () => {
    if (skipReason) return expect(skipReason, skipReason).toBeUndefined();
    const { connection } = project!;
    const target = `postgresql://${connection.role}@127.0.0.1:${PROXY_PORT}/${connection.database}?sslmode=require&options=endpoint%3Dep-does-not-exist`;
    let result: string;
    try {
      result = execFileSync('psql', [target, '-tAc', 'select 1'], {
        encoding: 'utf8', env: { ...process.env, PGPASSWORD: connection.password, PGCONNECT_TIMEOUT: '20' },
      });
    } catch (error) {
      result = String((error as { stderr?: Buffer | string }).stderr ?? '');
    }
    expect(result).toMatch(/error/i);
    // Not "reason unclear": the control plane's error envelope has to survive the proxy's parser.
    expect(result).not.toMatch(/malformed error message|reason unclear/i);
  }, 60_000);
});

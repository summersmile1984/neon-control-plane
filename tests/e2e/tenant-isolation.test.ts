import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  api, computeContainerRunning, createProject, endpointState,
  preflight, psqlThroughProxy, settle, waitFor, type CreatedProject,
} from '../support/live.ts';

/**
 * Two projects on one local stack must not be able to reach each other. That is the isolation the
 * v2 API promises — a project is a boundary, not a label — and it is enforced by four layers. From
 * the bottom up:
 *
 *   storage   one pageserver tenant per project, one timeline per branch
 *   compute   one container per endpoint, its own PGDATA, its own port
 *   identity  per-branch roles with independent SCRAM verifiers
 *   routing   the proxy resolves the endpoint id to exactly one compute
 *
 * The interesting assertion is the crossed one: tenant A's credentials aimed at tenant B's
 * endpoint. That is what a leaked connection string or a copy-paste mistake actually looks like.
 *
 * Preconditions are the same as proxy-connect.test.ts and are reported as skips.
 */

let alpha: CreatedProject | undefined;
let beta: CreatedProject | undefined;
let skipReason: string | undefined = 'not initialised';

const SECRET_ALPHA = 'alpha-only-row';
const SECRET_BETA = 'beta-only-row';

function run(project: CreatedProject, sql: string, options: Parameters<typeof psqlThroughProxy>[3] = {}): string {
  return psqlThroughProxy(project.endpointId, project.connection, sql, options);
}

beforeAll(async () => {
  skipReason = await preflight();
  if (skipReason) return;

  alpha = await createProject('e2e-tenant-alpha');
  beta = await createProject('e2e-tenant-beta');
  await settle(alpha.projectId);
  await settle(beta.projectId);

  expect(run(alpha, 'create table secrets(note text)')).toBe('CREATE TABLE');
  expect(run(alpha, `insert into secrets values ('${SECRET_ALPHA}')`)).toBe('INSERT 0 1');
  expect(run(beta, 'create table secrets(note text)')).toBe('CREATE TABLE');
  expect(run(beta, `insert into secrets values ('${SECRET_BETA}')`)).toBe('INSERT 0 1');
}, 300_000);

afterAll(async () => {
  for (const project of [alpha, beta]) {
    if (project) await api(`/projects/${project.projectId}`, { method: 'DELETE' }).catch(() => undefined);
  }
}, 180_000);

beforeEach((context) => {
  if (skipReason) context.skip(skipReason);
});

describe('two tenants on one local stack', () => {
  it('gives each project its own tenant, timeline, endpoint and compute container', async () => {
    if (skipReason) return expect(skipReason, skipReason).toBeUndefined();

    expect(alpha!.projectId).not.toBe(beta!.projectId);
    expect(alpha!.branchId).not.toBe(beta!.branchId);
    expect(alpha!.endpointId).not.toBe(beta!.endpointId);
    expect(computeContainerRunning(alpha!.endpointId)).toBe(true);
    expect(computeContainerRunning(beta!.endpointId)).toBe(true);
    // Distinct compute processes, so neither can read the other's PGDATA.
    expect(run(alpha!, 'select inet_server_addr()')).not.toBe('');
    expect(run(alpha!, 'select pg_backend_pid()')).not.toBe(run(beta!, 'select pg_backend_pid()'));
  });

  it('keeps each tenant\'s rows invisible to the other', () => {
    if (skipReason) return expect(skipReason, skipReason).toBeUndefined();
    expect(run(alpha!, 'select note from secrets')).toBe(SECRET_ALPHA);
    expect(run(beta!, 'select note from secrets')).toBe(SECRET_BETA);
  });

  it('refuses tenant A credentials pointed at tenant B endpoint', () => {
    if (skipReason) return expect(skipReason, skipReason).toBeUndefined();

    // Alpha's role name and password, but Beta's endpoint: the proxy asks the control plane for
    // Beta's verifier for that role name, and either the role does not exist on Beta's branch or
    // its verifier does not match Alpha's password. Either way the session must not open.
    const crossed = psqlThroughProxy(beta!.endpointId, beta!.connection, 'select note from secrets', {
      role: alpha!.connection.role,
      password: alpha!.connection.password,
      database: alpha!.connection.database,
    });
    expect(crossed).toMatch(/^ERROR:/);
    expect(crossed).not.toContain(SECRET_BETA);
    expect(crossed).not.toContain(SECRET_ALPHA);
  });

  it('scopes a role created on one branch to that branch only', async () => {
    if (skipReason) return expect(skipReason, skipReason).toBeUndefined();

    const created = await api(`/projects/${alpha!.projectId}/branches/${alpha!.branchId}/roles`, {
      method: 'POST', body: JSON.stringify({ role: { name: 'tenant_probe' } }),
    });
    await settle(alpha!.projectId);
    const password = (created.role as { password: string }).password;

    // The new role works on its own branch.
    expect(run(alpha!, 'select current_user', { role: 'tenant_probe', password })).toBe('tenant_probe');
    // The same name and password are meaningless on the other tenant.
    const crossed = psqlThroughProxy(beta!.endpointId, beta!.connection, 'select current_user', {
      role: 'tenant_probe', password, database: beta!.connection.database,
    });
    expect(crossed).toMatch(/^ERROR:/);

    const roles = (await api(`/projects/${beta!.projectId}/branches/${beta!.branchId}/roles`)).roles as Array<{ name: string }>;
    expect(roles.map((row) => row.name)).not.toContain('tenant_probe');
  }, 180_000);

  it('leaves one tenant untouched while the other is suspended', async () => {
    if (skipReason) return expect(skipReason, skipReason).toBeUndefined();

    await api(`/projects/${alpha!.projectId}/endpoints/${alpha!.endpointId}/suspend`, { method: 'POST' });
    await settle(alpha!.projectId);
    expect(await endpointState(alpha!.projectId, alpha!.endpointId)).toBe('idle');

    expect(await endpointState(beta!.projectId, beta!.endpointId)).toBe('active');
    expect(run(beta!, 'select note from secrets')).toBe(SECRET_BETA);

    // And waking Alpha does not disturb Beta.
    expect(run(alpha!, 'select note from secrets')).toBe(SECRET_ALPHA);
    expect(run(beta!, 'select note from secrets')).toBe(SECRET_BETA);
  }, 240_000);

  it('deletes one tenant without taking the other down', async () => {
    if (skipReason) return expect(skipReason, skipReason).toBeUndefined();

    const goneEndpoint = alpha!.endpointId;
    await api(`/projects/${alpha!.projectId}`, { method: 'DELETE' });
    // The project row is soft-deleted immediately, so its operations stop being listable; the
    // observable effect of the teardown is the compute container going away.
    await waitFor(`compute ${goneEndpoint} to be removed`, () => !computeContainerRunning(goneEndpoint));

    expect(run(beta!, 'select note from secrets')).toBe(SECRET_BETA);
    expect(computeContainerRunning(beta!.endpointId)).toBe(true);
    alpha = undefined; // already deleted; keep afterAll from reporting a spurious failure
  }, 240_000);
});

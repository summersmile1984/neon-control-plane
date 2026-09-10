import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  api, computeContainerRunning, createProject, endpointState,
  preflight, psqlThroughProxy, PROXY_PORT, settle, waitFor, type CreatedProject,
} from '../support/live.ts';

/**
 * T-203: Directus runs on a database this control plane issued.
 *
 *   Directus  --pg-->  Neon proxy :5434  -->  compute container  -->  pageserver
 *
 * The connection string is the one the control plane handed out, with the endpoint carried in the
 * startup packet (`options=endpoint=...`) rather than in SNI, because the container reaches the
 * proxy as `host.docker.internal` and cannot put the endpoint id in that hostname.
 *
 * Preconditions (skipped, not failed, when missing): the live stack from live.ts, plus a locally
 * built `siteops-directus-container` image — `scripts/directus-local-harness.sh up` in the sibling
 * siteops-platform checkout builds one. Override with DIRECTUS_IMAGE.
 */

const CONTAINER = 'neon-cp-e2e-directus';
const HOST_PORT = Number(process.env.DIRECTUS_E2E_PORT ?? 8056);
const ADMIN_TOKEN = 'local_healthcheck_token_0000000000000000';

let project: CreatedProject | undefined;
let skipReason: string | undefined = 'not initialised';

function newestLocalImage(): string | undefined {
  if (process.env.DIRECTUS_IMAGE) return process.env.DIRECTUS_IMAGE;
  const rows = execFileSync('docker', ['images', '--format', '{{.CreatedAt}}|{{.Repository}}:{{.Tag}}'], { encoding: 'utf8' })
    .split('\n')
    .filter((row) => row.includes('|siteops-directus-container:'))
    .sort()
    .reverse();
  return rows[0]?.split('|')[1];
}

/**
 * Everything the image's config gate demands. Only DB_CONNECTION_STRING is under test; the rest
 * are local-only fixtures. The EDGE_DATA_* block is required by images built before that extension
 * was retired and is ignored by newer ones.
 */
function environment(connectionString: string): string[] {
  const values: Record<string, string> = {
    ENVIRONMENT: 'local', NODE_ENV: 'production', PORT: '8055', HOST: '0.0.0.0',
    PUBLIC_URL: `http://localhost:${HOST_PORT}`,
    DB_CLIENT: 'pg', DB_CONNECTION_STRING: connectionString, DB_POOL__MIN: '0', DB_POOL__MAX: '3',
    DIRECTUS_RUNTIME_START_MODE: 'official_bootstrap',
    SECRET: 'siteops_local_directus_secret_00000000000000',
    ADMIN_EMAIL: 'admin@example.com', ADMIN_PASSWORD: 'siteops_local_admin_password_please_change',
    ADMIN_TOKEN, DIRECTUS_HEALTHCHECK_TOKEN: ADMIN_TOKEN,
    TELEMETRY: 'false', EXTENSIONS_PATH: '/directus/extensions',
    SITEOPS_DIRECTUS_SOURCE_REVISION: 'neon-cp-e2e',
    DIRECTUS_CELL_ORGANIZATION_ID: 'org_fixture', DIRECTUS_CELL_WORKSPACE_ID: 'ws_fixture', DIRECTUS_CELL_SITE_ID: 'site_fixture',
    EDGE_DATA_GATEWAY_URL: 'http://host.docker.internal:8799',
    EDGE_DATA_TOKEN_EXCHANGE_URL: 'http://host.docker.internal:8799/token',
    EDGE_DATA_SERVICE_SECRET: 'local_edge_data_service_secret_000000000',
    EDGE_DATA_ORGANIZATION_ID: 'org_fixture', EDGE_DATA_WORKSPACE_ID: 'ws_fixture', EDGE_DATA_SITE_ID: 'site_fixture',
    DIRECTUS_ACCOUNTABILITY_ENFORCEMENT: 'true',
    DIRECTUS_ACCOUNTABILITY_PROJECTION_SECRET: 'local_projection_secret_0000000000000000',
    DIRECTUS_ACCOUNTABILITY_JIT_SIGNING_SECRET: 'local_jit_signing_secret_00000000000000',
    DIRECTUS_ACCOUNTABILITY_JIT_SERVICE_SECRET: 'local_jit_service_secret_000000000000000',
    DIRECTUS_OIDC_TRANSACTION_SECRET: 'local_oidc_transaction_secret_0000000000',
    LOG_LEVEL: 'info',
  };
  return Object.entries(values).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
}

async function directus(path: string): Promise<number> {
  try {
    const response = await fetch(`http://127.0.0.1:${HOST_PORT}${path}`, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });
    return response.status;
  } catch {
    return 0;
  }
}

function sql(statement: string): string {
  return psqlThroughProxy(project!.endpointId, project!.connection, statement);
}

function logs(): string {
  return execFileSync('docker', ['logs', '--tail', '40', CONTAINER], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

beforeAll(async () => {
  skipReason = await preflight();
  if (skipReason) return;
  const image = newestLocalImage();
  if (!image) {
    skipReason = 'no local siteops-directus-container image; build one with the SiteOps harness or set DIRECTUS_IMAGE';
    return;
  }

  project = await createProject('e2e-directus');
  await settle(project.projectId);
  const { role, password, database } = project.connection;
  // host.docker.internal is the proxy as seen from inside the Directus container; the endpoint id
  // travels in the startup packet because it cannot be part of that hostname.
  const connectionString = `postgresql://${role}:${encodeURIComponent(password)}@host.docker.internal:${PROXY_PORT}`
    + `/${database}?sslmode=no-verify&options=endpoint%3D${project.endpointId}`;

  execFileSync('docker', ['rm', '-f', CONTAINER], { stdio: 'ignore' });
  execFileSync('docker', [
    'run', '-d', '--name', CONTAINER, '-p', `${HOST_PORT}:8055`, '--platform', 'linux/amd64',
    '--add-host', 'host.docker.internal:host-gateway',
    ...environment(connectionString), image,
  ], { stdio: 'ignore' });

  await waitFor('Directus to answer /server/ping', async () => (await directus('/server/ping')) === 200, 240_000);
}, 420_000);

afterAll(async () => {
  execFileSync('docker', ['rm', '-f', CONTAINER], { stdio: 'ignore' });
  if (project) await api(`/projects/${project.projectId}`, { method: 'DELETE' }).catch(() => undefined);
}, 180_000);

describe('Directus on a control-plane database', () => {
  it('completes its bootstrap migrations against the Neon compute', () => {
    if (skipReason) return expect(skipReason, skipReason).toBeUndefined();
    expect(logs()).toContain('"outcome":"succeeded"');
    // Migration count is the acceptance signal; the exact number tracks the Directus version.
    expect(Number(sql('select count(*) from directus_migrations'))).toBeGreaterThan(100);
    expect(Number(sql("select count(*) from information_schema.tables where table_name like 'directus_%'"))).toBeGreaterThan(30);
    expect(sql('select count(*) from directus_users')).toBe('1');
    // The schema is on the compute the control plane started, not on some other database.
    expect(sql('select inet_server_port()')).toBe('55433');
    expect(sql('select version()')).toMatch(/^PostgreSQL 17\./);
  });

  it('serves an authenticated read through the proxy', async () => {
    if (skipReason) return expect(skipReason, skipReason).toBeUndefined();
    expect(await directus('/users?limit=1')).toBe(200);
  });

  /**
   * Scale-to-zero is the behaviour this differs on, and it is the same locally and on Neon cloud:
   * the compute is gone, so the request that arrives first fails fast rather than blocking, the
   * proxy wakes the compute in the background, and the next request succeeds. Anything long-lived
   * that talks to a suspended branch needs a retry, not a longer timeout.
   */
  it('recovers on the next request after the compute is suspended', async () => {
    if (skipReason) return expect(skipReason, skipReason).toBeUndefined();
    const { projectId, endpointId } = project!;

    // Freeze Directus first: its readiness probe polls the database and would wake the compute
    // again before the suspend could be observed.
    execFileSync('docker', ['pause', CONTAINER], { stdio: 'ignore' });
    try {
      await api(`/projects/${projectId}/endpoints/${endpointId}/suspend`, { method: 'POST' });
      await settle(projectId);
      expect(await endpointState(projectId, endpointId)).toBe('idle');
      expect(computeContainerRunning(endpointId)).toBe(false);
    } finally {
      execFileSync('docker', ['unpause', CONTAINER], { stdio: 'ignore' });
    }

    await waitFor('Directus to serve a read again', async () => (await directus('/users?limit=1')) === 200, 120_000);
    expect(await endpointState(projectId, endpointId)).toBe('active');
    // No data was lost across the suspend.
    expect(sql('select count(*) from directus_users')).toBe('1');
  }, 300_000);
});

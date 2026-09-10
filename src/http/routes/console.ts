import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Context, Hono } from 'hono';
import type { AppDeps, AppEnv } from '../app.ts';
import { bearerAuth } from '../auth.ts';
import type { DockerClient } from '../../adapters/docker.ts';
import type { PageserverClient } from '../../adapters/pageserver.ts';
import type { EndpointRow, OperationRow } from '../../store/rows.ts';

/**
 * A local operations console for this stack. It is a development tool, not a product surface and
 * not part of the Neon contract, so it lives outside `/api/v2`: nothing here is validated against
 * the vendored OpenAPI schema and nothing here should ever be depended on by a client.
 *
 *   GET /            -> the page
 *   GET /console     -> the page
 *   GET /console/state -> one aggregated snapshot (behind the same API key as /api/v2)
 *
 * Writes are deliberately absent: the page calls the real `/api/v2` routes for every action, so
 * the console exercises the same contract as `provider-neon` and `neonctl` rather than a private
 * back door that could drift from it.
 *
 * The one thing this endpoint does that the v2 API cannot is report **drift**: the endpoint row
 * says `active` while its compute container is gone, or the reverse. That mismatch is the single
 * most useful signal when the local stack misbehaves, and it needs both sources at once.
 */

const PAGE_PATH = fileURLToPath(new URL('../../console/index.html', import.meta.url));
const RECENT_OPERATIONS = 60;

export interface ConsoleEndpointView {
  readonly id: string;
  readonly branch_id: string;
  readonly type: string;
  readonly state: string;
  readonly pending_state: string | null;
  readonly host: string;
  readonly pg_port: number;
  readonly disabled: boolean;
  readonly suspend_timeout_seconds: number;
  readonly last_active: string | null;
  /** 'running' | 'stopped' | 'missing' | 'unknown' when docker could not be reached. */
  readonly container: string;
  /** A code, not a sentence: the page owns the wording, and it is the only consumer. */
  readonly drift: DriftCode | null;
}

/**
 * `container_missing` usually means someone ran `docker rm` by hand or a start_compute failed
 * after the row was already marked active; `still_running` means a suspend did not finish.
 */
export type DriftCode = 'container_missing' | 'container_stopped' | 'still_running';

function driftOf(endpoint: EndpointRow, container: string): DriftCode | null {
  if (container === 'unknown') return null;
  if (endpoint.current_state === 'active' && container === 'missing') return 'container_missing';
  if (endpoint.current_state === 'active' && container === 'stopped') return 'container_stopped';
  if (endpoint.current_state === 'idle' && container === 'running') return 'still_running';
  return null;
}

function operationView(row: OperationRow): Record<string, unknown> {
  return {
    id: row.id,
    project_id: row.project_id,
    endpoint_id: row.endpoint_id,
    action: row.action,
    status: row.status,
    error: row.error,
    failures_count: row.failures_count,
    cursor_step: row.cursor_step,
    total_duration_ms: row.total_duration_ms,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** Reports reachability without throwing, so one dead dependency cannot blank the whole page. */
async function probe(check: () => Promise<unknown>): Promise<{ ok: boolean; error?: string }> {
  try {
    await check();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: (error as Error).message.slice(0, 200) };
  }
}

export function registerConsoleRoutes(app: Hono<AppEnv>, deps: AppDeps): void {
  const { repos, config, logger } = deps;
  const docker = deps.docker as DockerClient | undefined;
  const pageserver = deps.pageserver as PageserverClient | undefined;

  /**
   * Maps endpoint id -> container state. An empty map with `ok:false` means docker is unreachable.
   *
   * Deliberately not cached: this endpoint exists to say what is true right now, and the page's
   * poll interval already bounds how often docker is asked. A cache would make the snapshot lie
   * for a second or two after every start/suspend, which is exactly when someone is watching.
   */
  async function containerStates(): Promise<{ ok: boolean; byEndpoint: Map<string, string> }> {
    if (!docker) return { ok: false, byEndpoint: new Map() };
    try {
      const containers = await docker.listByLabel('neon-cp.endpoint_id');
      const byEndpoint = new Map<string, string>();
      for (const container of containers) {
        const id = container.labels['neon-cp.endpoint_id'];
        if (id) byEndpoint.set(id, container.running ? 'running' : 'stopped');
      }
      return { ok: true, byEndpoint };
    } catch (error) {
      logger.debug('console could not list containers', { error: (error as Error).message });
      return { ok: false, byEndpoint: new Map() };
    }
  }

  // Read per request rather than at startup: editing the page and reloading the browser is the
  // whole development loop for it, and this endpoint is hit once per page view.
  const servePage = (c: Context<AppEnv>): Response =>
    c.html(readFileSync(PAGE_PATH, 'utf8'), 200, { 'cache-control': 'no-store' });

  app.get('/', servePage);
  app.get('/console', servePage);

  // Same gate as /api/v2: the snapshot carries every project and endpoint in the stack.
  app.get('/console/state', bearerAuth(repos), async (c) => {
    const containers = await containerStates();
    const projects = repos.projects.list(200);

    const health = {
      route_mode: config.routeMode,
      zone: config.zone,
      pageserver_url: config.pageserverUrl,
      api_keys: repos.apiKeys.count(),
      docker: containers.ok ? { ok: true } : { ok: false, error: 'containers could not be listed' },
      pageserver: pageserver ? await probe(() => pageserver.status()) : { ok: false, error: 'no pageserver client' },
    };

    const detailed = projects.map((project) => {
      const branches = repos.branches.listByProject(project.id);
      const endpoints = repos.endpoints.listByProject(project.id).map((endpoint): ConsoleEndpointView => {
        const container = containers.ok ? (containers.byEndpoint.get(endpoint.id) ?? 'missing') : 'unknown';
        return {
          id: endpoint.id,
          branch_id: endpoint.branch_id,
          type: endpoint.type,
          state: endpoint.current_state,
          pending_state: endpoint.pending_state,
          host: endpoint.host,
          pg_port: endpoint.pg_port,
          disabled: endpoint.disabled === 1,
          suspend_timeout_seconds: endpoint.suspend_timeout_seconds,
          last_active: endpoint.last_active,
          container,
          drift: driftOf(endpoint, container),
        };
      });

      return {
        id: project.id,
        name: project.name,
        pg_version: project.pg_version,
        tenant_id: project.tenant_id,
        store_passwords: project.store_passwords === 1,
        default_branch_id: project.default_branch_id,
        created_at: project.created_at,
        branches: branches.map((branch) => ({
          id: branch.id,
          name: branch.name,
          timeline_id: branch.timeline_id,
          parent_id: branch.parent_id,
          parent_lsn: branch.parent_lsn,
          parent_timestamp: branch.parent_timestamp,
          is_default: branch.is_default === 1,
          state: branch.current_state,
          logical_size: branch.logical_size,
          roles: repos.roles.listByBranch(branch.id).map((role) => ({
            name: role.name,
            no_login: role.no_login === 1,
            // Never the password itself: the page asks /api/v2 reveal_password on an explicit click.
            has_stored_password: role.password_ciphertext !== null,
          })),
          databases: repos.databases.listByBranch(branch.id).map((database) => ({
            name: database.name, owner_name: database.owner_name,
          })),
        })),
        endpoints,
      };
    });

    const operations = repos.operations.listRecent(RECENT_OPERATIONS).map(operationView);
    const drifting = detailed.flatMap((project) => project.endpoints.filter((endpoint) => endpoint.drift !== null));

    return c.json({
      generated_at: new Date().toISOString(),
      health,
      summary: {
        projects: detailed.length,
        endpoints: detailed.reduce((total, project) => total + project.endpoints.length, 0),
        running_computes: [...containers.byEndpoint.values()].filter((state) => state === 'running').length,
        pending_operations: operations.filter((row) => row.status === 'scheduling' || row.status === 'running').length,
        failed_operations: operations.filter((row) => row.status === 'failed').length,
        drifting_endpoints: drifting.length,
      },
      projects: detailed,
      operations,
    }, 200, { 'cache-control': 'no-store' });
  });
}

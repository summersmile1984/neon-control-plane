import type { Context, Hono } from 'hono';
import type { AppDeps, AppEnv } from '../app.ts';
import { ApiError, errors } from '../errors.ts';
import type { EndpointRow } from '../../store/rows.ts';

/**
 * The private API the Neon proxy calls (002 §10, T-301). Shapes come from the proxy source
 * (`proxy/src/control_plane/client/cplane_proxy_v1.rs` and `messages.rs`); there is no published
 * contract, so `tests/contract/cplane-shape.test.ts` pins them and a proxy upgrade is expected to
 * be paired with re-reading those two files.
 *
 *   GET /cplane/get_endpoint_access_control?session_id&application_name&endpointish&role
 *   GET /cplane/wake_compute?session_id&application_name&endpointish
 *
 * Two things measured against proxy build 8464 on 2026-09-07:
 *   - the proxy joins the method name onto `--auth-endpoint` with its own slash, so that flag must
 *     NOT end in one;
 *   - errors must be `ControlPlaneErrorMessage { error, http_status_code, status }`. The v2
 *     `GeneralError` shape makes the proxy log `failed to parse error body: missing field 'error'`
 *     and report "reason unclear" to the client.
 */

const WAKE_TIMEOUT_MS = 30_000;

/**
 * The proxy's `ColdStartInfo` enum, which it deserialises strictly: an unlisted value fails the
 * whole wake_compute response with `unknown variant ...` and the client sees only "Control plane
 * request failed". There is deliberately no `cold` variant — a start from nothing is a pool miss.
 */
const COLD_START_WARM = 'warm';
const COLD_START_MISS = 'pool_miss';

/** Requests under this prefix must fail in the proxy's error shape, not the v2 `GeneralError` one. */
export const CPLANE_PREFIX = '/cplane';

export function isCplanePath(pathname: string): boolean {
  return pathname === CPLANE_PREFIX || pathname.startsWith(`${CPLANE_PREFIX}/`);
}

/** `status.details.retry_info` is how the proxy learns a failure is worth retrying. */
export interface ControlPlaneErrorBody {
  readonly error: string;
  readonly http_status_code: number;
  readonly status?: { readonly details: { readonly retry_info?: { readonly retry_delay_ms: number } } };
}

export function cplaneErrorBody(message: string, httpStatus: number, retryDelayMs?: number): ControlPlaneErrorBody {
  return {
    error: message,
    http_status_code: httpStatus,
    ...(retryDelayMs === undefined ? {} : { status: { details: { retry_info: { retry_delay_ms: retryDelayMs } } } }),
  };
}

function cplaneError(c: Context, error: ApiError, retryDelayMs?: number): Response {
  return c.json(cplaneErrorBody(error.message, error.httpStatus, retryDelayMs), error.httpStatus as 404);
}

/** The proxy passes the first SNI label, which is the endpoint id, optionally `-pooler` suffixed. */
function resolveEndpoint(deps: AppDeps, endpointish: string): EndpointRow {
  const id = endpointish.replace(/-pooler$/, '');
  const endpoint = deps.repos.endpoints.get(id);
  if (!endpoint) throw errors.endpointNotFound(id);
  return endpoint;
}

export function registerCplaneRoutes(app: Hono<AppEnv>, deps: AppDeps): void {
  const { repos, config, logger } = deps;

  const guard = (header: string | undefined): void => {
    if (!config.proxyToken) return;
    const match = /^Bearer\s+(.+)$/i.exec((header ?? '').trim());
    if (!match || match[1]!.trim() !== config.proxyToken) throw errors.unauthorized('proxy token is missing or invalid');
  };

  /** Wraps a handler so failures come back in the proxy's error shape rather than GeneralError. */
  const cplane = (handler: (c: Context) => Promise<Response> | Response) => async (c: Context): Promise<Response> => {
    try {
      return await handler(c);
    } catch (error) {
      if (error instanceof ApiError) {
        // A resource that is merely busy is retryable; anything else is final for this attempt.
        const retryDelay = error.httpStatus === 423 ? 1000 : undefined;
        return cplaneError(c, error, retryDelay);
      }
      logger.error('cplane request failed', { error: error instanceof Error ? error.message : String(error) });
      return cplaneError(c, errors.internal());
    }
  };

  /**
   * Registers a method under both `/cplane/x` and `/cplane//x`. A `--auth-endpoint` that ends in a
   * slash produces the doubled form, and the resulting 404 is opaque from the client side, so the
   * alias costs one line and removes a debugging session.
   */
  const method = (name: string, handler: (c: Context) => Promise<Response> | Response): void => {
    app.get(`${CPLANE_PREFIX}/${name}`, cplane(handler));
    app.get(`${CPLANE_PREFIX}//${name}`, cplane(handler));
  };

  method('get_endpoint_access_control', (c) => {
    guard(c.req.header('authorization'));
    const endpointish = c.req.query('endpointish');
    const role = c.req.query('role');
    if (!endpointish || !role) throw errors.badRequest('endpointish and role are required');

    const endpoint = resolveEndpoint(deps, endpointish);
    const roleRow = repos.roles.get(endpoint.branch_id, role);
    if (!roleRow?.scram_secret) throw errors.roleNotFound(role);
    const project = repos.projects.get(endpoint.project_id);
    if (!project) throw errors.projectNotFound(endpoint.project_id);

    logger.debug('proxy asked for access control', { endpoint_id: endpoint.id, role });
    return c.json({
      // The proxy runs SCRAM against this verifier itself; the plaintext never leaves the control plane.
      role_secret: roleRow.scram_secret,
      allowed_ips: [],
      allowed_vpc_endpoint_ids: [],
      block_public_connections: false,
      block_vpc_connections: false,
      project_id: project.id,
      account_id: 'org-local',
    });
  });

  method('wake_compute', async (c) => {
    guard(c.req.header('authorization'));
    const endpointish = c.req.query('endpointish');
    if (!endpointish) throw errors.badRequest('endpointish is required');

    const endpoint = resolveEndpoint(deps, endpointish);
    if (endpoint.disabled) throw errors.badRequest(`endpoint ${endpoint.id} is disabled`);
    const wasActive = endpoint.current_state === 'active';

    if (!wasActive) {
      const { reconciler } = deps;
      if (!reconciler) throw errors.internal('no reconciler is attached');
      if (!repos.operations.hasActiveFor({ endpoint_id: endpoint.id })) deps.service.startEndpoint(endpoint);

      // The proxy blocks on this call while a client waits for its connection, so drive the
      // operation here instead of waiting for the background tick. `claimNext` is a CAS, so a
      // concurrent background tick cannot run the same step twice.
      const deadline = Date.now() + WAKE_TIMEOUT_MS;
      let state = repos.endpoints.get(endpoint.id)?.current_state;
      while (state !== 'active' && Date.now() < deadline) {
        const ran = await reconciler.drain();
        // Nothing claimable means another worker holds the operation; give it a moment.
        if (ran === 0) await new Promise((resolve) => setTimeout(resolve, 250));
        state = repos.endpoints.get(endpoint.id)?.current_state;
      }
      // The proxy treats this class as retryable and will ask again.
      if (state !== 'active') throw errors.runningOperations(`endpoint ${endpoint.id} is still starting`);
      logger.info('woke a compute for the proxy', { endpoint_id: endpoint.id });
    }

    repos.endpoints.touchActivity(endpoint.id);
    const fresh = repos.endpoints.get(endpoint.id)!;
    return c.json({
      // Inside the compose network the compute answers on its container name and internal port.
      address: `${fresh.id}:55433`,
      aux: {
        endpoint_id: fresh.id,
        project_id: fresh.project_id,
        branch_id: fresh.branch_id,
        compute_id: fresh.id,
        cold_start_info: wasActive ? COLD_START_WARM : COLD_START_MISS,
      },
    });
  });
}

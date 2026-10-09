import { Hono, type Context } from 'hono';
import { randomUUID } from 'node:crypto';
import type { Config } from '../config.ts';
import type { Logger } from '../logger.ts';
import type { Repositories } from '../store/repo.ts';
import type { Service } from '../service.ts';
import type { Reconciler } from '../reconciler/loop.ts';
import type { ViewContext } from '../domain/views.ts';
import { ApiError, errors } from './errors.ts';
import { validatedErrorBody } from './respond.ts';
import { apiAuth } from './auth.ts';
import { orgGuard, projectGuard } from './guard.ts';
import { registerProjectRoutes, registerSharedProjectsRoute } from './routes/projects.ts';
import { registerBranchRoutes } from './routes/branches.ts';
import { registerEndpointRoutes } from './routes/endpoints.ts';
import { registerApiKeyRoutes } from './routes/api-keys.ts';
import { registerIdentityRoutes } from './routes/identity.ts';
import { registerOrganizationRoutes } from './routes/organizations.ts';
import { cplaneErrorBody, isCplanePath, registerCplaneRoutes } from './routes/cplane.ts';
import { registerConsoleRoutes } from './routes/console.ts';
import type { DockerClient } from '../adapters/docker.ts';
import type { PageserverClient } from '../adapters/pageserver.ts';
import type { ComputeClient } from '../adapters/compute.ts';
import type { AppEnv } from './env.ts';

export type { AppEnv };

export interface AppDeps {
  readonly repos: Repositories;
  readonly service: Service;
  readonly config: Config;
  readonly logger: Logger;
  readonly reconciler?: Reconciler;
  /** Authenticated catalog reads let the proxy authenticate SQL-created, least-privilege roles. */
  readonly compute?: Pick<ComputeClient, 'dbsAndRoles'>;
  /** Read-only, and only for the console's stack snapshot; the API itself never touches these. */
  readonly docker?: DockerClient;
  readonly pageserver?: PageserverClient;
}

export function viewContext(config: Config): ViewContext {
  return { zone: config.zone, creationSource: 'neon-control-plane', ownerId: config.identity.orgId };
}

export function createApp(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    const requestId = c.req.header('x-request-id') ?? randomUUID();
    c.set('requestId', requestId);
    c.header('x-request-id', requestId);
    // Tells a client which routing tier the connection strings in this response use.
    c.header('x-neon-cp-mode', deps.config.routeMode);
    await next();
  });

  /** The proxy parses a different error envelope; a GeneralError reaches it as "reason unclear". */
  const forProxy = (c: Context): boolean => isCplanePath(new URL(c.req.url).pathname);

  app.onError((error, c) => {
    const requestId = c.get('requestId');
    if (error instanceof ApiError) {
      if (error.httpStatus >= 500) deps.logger.error('request failed', { request_id: requestId, code: error.code, error: error.message });
      if (forProxy(c)) return c.json(cplaneErrorBody(error.message, error.httpStatus), error.httpStatus as 400);
      return c.json(validatedErrorBody({ ...error.toBody(), request_id: requestId }), error.httpStatus as 400);
    }
    deps.logger.error('unhandled error', { request_id: requestId, error: error instanceof Error ? error.message : String(error) });
    const internal = errors.internal();
    if (forProxy(c)) return c.json(cplaneErrorBody(internal.message, 500), 500);
    return c.json(validatedErrorBody({ ...internal.toBody(), request_id: requestId }), 500);
  });

  app.notFound((c) => {
    const notFound = errors.notImplemented(`${c.req.method} ${new URL(c.req.url).pathname}`);
    if (forProxy(c)) return c.json(cplaneErrorBody(notFound.message, 404), 404);
    return c.json(validatedErrorBody({ code: 'RESOURCE_NOT_FOUND', message: notFound.message, request_id: c.get('requestId') }), 404);
  });

  app.get('/healthz', (c) => c.json({ status: 'ok' }));
  app.get('/readyz', (c) => {
    const pending = deps.repos.db.prepare("SELECT COUNT(*) AS total FROM operations WHERE status IN ('scheduling','running')").get() as { total: number };
    return c.json({ status: 'ok', route_mode: deps.config.routeMode, pending_operations: pending.total });
  });

  const api = new Hono<AppEnv>();
  api.use('*', apiAuth(deps.repos));

  // Ahead of the scope guards below: they match `/projects/:project_id`, and "shared" is a literal,
  // not a project id — the guard would 404 it before the route below could answer.
  registerSharedProjectsRoute(api);

  // Scope guards run before any project/organization handler: a credential may only reach the
  // resources its key or session is entitled to see (design 004).
  api.use('/projects/:project_id', projectGuard(deps.repos, deps.config));
  api.use('/projects/:project_id/*', projectGuard(deps.repos, deps.config));
  api.use('/organizations/:org_id', orgGuard(deps.repos));
  api.use('/organizations/:org_id/*', orgGuard(deps.repos));

  registerIdentityRoutes(api, deps);
  registerApiKeyRoutes(api, deps);
  registerOrganizationRoutes(api, deps);
  registerProjectRoutes(api, deps);
  registerBranchRoutes(api, deps);
  registerEndpointRoutes(api, deps);

  // The proxy calls this private API directly, outside /api/v2 and outside the API-key middleware
  // (it presents CP_PROXY_TOKEN instead).
  registerCplaneRoutes(app, deps);

  // Local operations console. Also outside /api/v2 — it is a development tool, not part of the
  // Neon contract, and nothing under it is schema-validated.
  registerConsoleRoutes(app, deps);

  app.route('/api/v2', api);
  return app;
}

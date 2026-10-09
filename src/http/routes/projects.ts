import type { Hono } from 'hono';
import type { AppDeps, AppEnv } from '../app.ts';
import { viewContext } from '../app.ts';
import { respond } from '../respond.ts';
import { errors } from '../errors.ts';
import { branchView, databaseView, endpointView, operationView, projectListItemView, projectView, roleView } from '../../domain/views.ts';
import {
  checkRequest, findBranch, findEndpoint, findProject, jsonBody, operationsView,
  optionalBoolean, optionalInteger, optionalString, section,
} from './helpers.ts';
import { principalOrgIds, resolveActingOrg } from '../guard.ts';

/**
 * `GET /projects/shared` is a literal path that sits next to `/projects/:project_id`. Registering it
 * here does not help: the project guard matches `/projects/:project_id` first and 404s on the word
 * "shared" before any handler here runs. The caller registers it ahead of that guard.
 *
 * A self-hosted plane shares nothing across accounts, but `neonctl projects list` calls this.
 */
export function registerSharedProjectsRoute(api: Hono<AppEnv>): void {
  api.get('/projects/shared', (c) => respond(c, 'ProjectsResponse', { projects: [] }));
}

/** `/projects`, `/projects/{id}`, operations and `connection_uri` (002 §4.1). */
export function registerProjectRoutes(api: Hono<AppEnv>, deps: AppDeps): void {
  const { repos, service, config } = deps;
  const context = viewContext(config);

  api.get('/projects', (c) => {
    const limit = Math.min(Number(c.req.query('limit') ?? 100) || 100, 1000);
    const cursor = c.req.query('cursor');
    const principal = c.get('principal');
    const allowed = new Set(principalOrgIds(repos, principal, config));
    const rows = repos.projects.list(limit, cursor).filter((row) => (principal.projectId
      ? row.id === principal.projectId
      : allowed.has(row.org_id ?? config.identity.orgId)));
    const body: Record<string, unknown> = { projects: rows.map((row) => projectListItemView(row, context)) };
    const last = rows.at(-1);
    if (last && rows.length === limit) body.pagination = { cursor: last.id };
    return respond(c, 'ProjectsResponse', body);
  });

  api.post('/projects', async (c) => {
    const body = await jsonBody(c);
    checkRequest('ProjectCreateRequest', body);
    const project = section(body, 'project');
    const branch = section(project, 'branch');

    const created = await service.createProject({
      ...(optionalString(project, 'name') === undefined ? {} : { name: optionalString(project, 'name')! }),
      ...(optionalInteger(project, 'pg_version') === undefined ? {} : { pgVersion: optionalInteger(project, 'pg_version')! }),
      ...(optionalInteger(project, 'history_retention_seconds') === undefined ? {} : { historyRetentionSeconds: optionalInteger(project, 'history_retention_seconds')! }),
      ...(optionalBoolean(project, 'store_passwords') === undefined ? {} : { storePasswords: optionalBoolean(project, 'store_passwords')! }),
      ...(project.settings ? { settings: section(project, 'settings') } : {}),
      ...(body.annotation_value ? { annotation: section(body, 'annotation_value') } : {}),
      ...(optionalString(branch, 'name') === undefined ? {} : { branchName: optionalString(branch, 'name')! }),
      ...(optionalString(branch, 'role_name') === undefined ? {} : { roleName: optionalString(branch, 'role_name')! }),
      ...(optionalString(branch, 'database_name') === undefined ? {} : { databaseName: optionalString(branch, 'database_name')! }),
      orgId: resolveActingOrg(repos, config, c.get('principal'), c.req.query('org_id')),
    });

    const connectionUris = created.endpoint
      ? [(() => {
        const built = service.connectionUri(created.project, created.branch, created.endpoint!, created.database.name, created.role.name, false);
        return {
          connection_uri: built.uri,
          connection_parameters: {
            database: built.parameters.database,
            password: built.parameters.password,
            role: built.parameters.role,
            host: built.parameters.host,
            pooler_host: built.parameters.host,
          },
        };
      })()]
      : [];

    return respond(c, 'responses:CreatedProject', {
      project: projectView(created.project, context),
      connection_uris: connectionUris,
      roles: [roleView(created.role, created.password)],
      databases: [databaseView(created.database)],
      operations: operationsView(created.operations),
      branch: branchView(created.branch, context),
      endpoints: created.endpoint ? [endpointView(created.endpoint, context)] : [],
    }, 201);
  });

  // Must be registered before /projects/:project_id or the literal is captured as an id.
  // A self-hosted plane has no cross-account sharing, but neonctl calls this on `projects list`.
  api.get('/projects/:project_id', (c) => {
    const project = findProject(repos, c.req.param('project_id'));
    return respond(c, 'ProjectResponse', { project: projectView(project, context) });
  });
  api.patch('/projects/:project_id', async (c) => {
    const project = findProject(repos, c.req.param('project_id'));
    const body = await jsonBody(c);
    checkRequest('ProjectUpdateRequest', body);
    const patch = section(body, 'project');
    const updated = repos.projects.update(project.id, {
      ...(optionalString(patch, 'name') === undefined ? {} : { name: optionalString(patch, 'name')! }),
      ...(patch.settings ? { settings_json: JSON.stringify(section(patch, 'settings')) } : {}),
      ...(optionalInteger(patch, 'history_retention_seconds') === undefined ? {} : { history_retention_seconds: optionalInteger(patch, 'history_retention_seconds')! }),
    });
    if (!updated) throw errors.projectNotFound(project.id);
    return respond(c, 'ProjectResponse', { project: projectView(updated, context), operations: [] });
  });

  api.delete('/projects/:project_id', (c) => {
    const project = findProject(repos, c.req.param('project_id'));
    service.deleteProject(project.id);
    // The row is soft-deleted by the operation; the response still describes the project, as the
    // spec types DELETE /projects/{id} as ProjectResponse rather than 204.
    return respond(c, 'ProjectResponse', { project: projectView(project, context) });
  });

  api.get('/projects/:project_id/operations', (c) => {
    const project = findProject(repos, c.req.param('project_id'));
    const limit = Math.min(Number(c.req.query('limit') ?? 100) || 100, 1000);
    return respond(c, 'OperationsResponse', { operations: operationsView(repos.operations.listByProject(project.id, limit)) });
  });

  api.get('/projects/:project_id/operations/:operation_id', (c) => {
    const project = findProject(repos, c.req.param('project_id'));
    const operation = repos.operations.get(c.req.param('operation_id'));
    if (!operation || operation.project_id !== project.id) throw errors.notImplemented('operation lookup');
    return respond(c, 'OperationResponse', { operation: operationView(operation) });
  });

  api.get('/projects/:project_id/connection_uri', (c) => {
    const project = findProject(repos, c.req.param('project_id'));
    const databaseName = c.req.query('database_name');
    const roleName = c.req.query('role_name');
    if (!databaseName || !roleName) throw errors.badRequest('database_name and role_name are required');

    const branchId = c.req.query('branch_id');
    const branch = branchId
      ? findBranch(repos, project, branchId)
      : findBranch(repos, project, project.default_branch_id ?? '');

    const endpointId = c.req.query('endpoint_id');
    const endpoint = endpointId
      ? findEndpoint(repos, project, endpointId)
      : repos.endpoints.listByBranch(branch.id).find((row) => row.type === 'read_write');
    if (!endpoint) throw errors.endpointNotFound(`read_write endpoint on branch ${branch.id}`);

    const pooled = c.req.query('pooled') === 'true';
    const built = service.connectionUri(project, branch, endpoint, databaseName, roleName, pooled);
    return respond(c, 'ConnectionURIResponse', { uri: built.uri });
  });
}

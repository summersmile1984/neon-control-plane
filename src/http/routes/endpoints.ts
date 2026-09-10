import type { Hono } from 'hono';
import type { AppDeps, AppEnv } from '../app.ts';
import { viewContext } from '../app.ts';
import { respond } from '../respond.ts';
import { errors } from '../errors.ts';
import { endpointView } from '../../domain/views.ts';
import type { EndpointType } from '../../store/rows.ts';
import {
  checkRequest, findBranch, findEndpoint, findProject, jsonBody, operationsView,
  optionalBoolean, optionalInteger, requiredString, section,
} from './helpers.ts';

/** Compute endpoints and their lifecycle (002 §4.1, §5.4). */
export function registerEndpointRoutes(api: Hono<AppEnv>, deps: AppDeps): void {
  const { repos, service, config } = deps;
  const context = viewContext(config);

  api.get('/projects/:project_id/endpoints', (c) => {
    const project = findProject(repos, c.req.param('project_id'));
    return respond(c, 'EndpointsResponse', {
      endpoints: repos.endpoints.listByProject(project.id).map((row) => endpointView(row, context)),
    });
  });

  api.post('/projects/:project_id/endpoints', async (c) => {
    const project = findProject(repos, c.req.param('project_id'));
    const body = await jsonBody(c);
    checkRequest('EndpointCreateRequest', body);
    const endpoint = section(body, 'endpoint');
    const branch = findBranch(repos, project, requiredString(endpoint, 'branch_id'));
    const type = requiredString(endpoint, 'type');
    if (type !== 'read_write' && type !== 'read_only') throw errors.badRequest('type must be read_write or read_only');

    const created = service.createEndpoint(
      project.id, branch.id, type as EndpointType,
      optionalInteger(endpoint, 'suspend_timeout_seconds'),
    );
    return respond(c, 'EndpointOperations', {
      endpoint: endpointView(created.endpoint, context),
      operations: operationsView(created.operations),
    }, 201);
  });

  api.get('/projects/:project_id/endpoints/:endpoint_id', (c) => {
    const project = findProject(repos, c.req.param('project_id'));
    const endpoint = findEndpoint(repos, project, c.req.param('endpoint_id'));
    return respond(c, 'EndpointResponse', { endpoint: endpointView(endpoint, context) });
  });

  api.patch('/projects/:project_id/endpoints/:endpoint_id', async (c) => {
    const project = findProject(repos, c.req.param('project_id'));
    const endpoint = findEndpoint(repos, project, c.req.param('endpoint_id'));
    const body = await jsonBody(c);
    checkRequest('EndpointUpdateRequest', body);
    const patch = section(body, 'endpoint');
    const updated = repos.endpoints.update(endpoint.id, {
      ...(optionalInteger(patch, 'suspend_timeout_seconds') === undefined ? {} : { suspend_timeout_seconds: optionalInteger(patch, 'suspend_timeout_seconds')! }),
      ...(optionalBoolean(patch, 'disabled') === undefined ? {} : { disabled: optionalBoolean(patch, 'disabled')! ? 1 : 0 }),
      ...(patch.settings ? { settings_json: JSON.stringify(section(patch, 'settings')) } : {}),
    });
    if (!updated) throw errors.endpointNotFound(endpoint.id);
    // Postgres settings only take effect on the next configure, so queue one when they changed.
    const operations = patch.settings ? [service.startEndpoint(updated)] : [];
    return respond(c, 'EndpointOperations', {
      endpoint: endpointView(updated, context),
      operations: operationsView(operations),
    });
  });

  api.delete('/projects/:project_id/endpoints/:endpoint_id', (c) => {
    const project = findProject(repos, c.req.param('project_id'));
    const endpoint = findEndpoint(repos, project, c.req.param('endpoint_id'));
    const operations = service.deleteEndpoint(endpoint);
    return respond(c, 'EndpointOperations', {
      endpoint: endpointView(endpoint, context),
      operations: operationsView(operations),
    });
  });

  api.post('/projects/:project_id/endpoints/:endpoint_id/start', (c) => {
    const project = findProject(repos, c.req.param('project_id'));
    const endpoint = findEndpoint(repos, project, c.req.param('endpoint_id'));
    if (repos.operations.hasActiveFor({ endpoint_id: endpoint.id })) throw errors.runningOperations();
    const operation = service.startEndpoint(endpoint);
    return respond(c, 'EndpointOperations', {
      endpoint: endpointView(endpoint, context),
      operations: operationsView([operation]),
    });
  });

  api.post('/projects/:project_id/endpoints/:endpoint_id/suspend', (c) => {
    const project = findProject(repos, c.req.param('project_id'));
    const endpoint = findEndpoint(repos, project, c.req.param('endpoint_id'));
    if (repos.operations.hasActiveFor({ endpoint_id: endpoint.id })) throw errors.runningOperations();
    const operation = service.suspendEndpoint(endpoint);
    return respond(c, 'EndpointOperations', {
      endpoint: endpointView(endpoint, context),
      operations: operationsView([operation]),
    });
  });

  api.post('/projects/:project_id/endpoints/:endpoint_id/restart', (c) => {
    const project = findProject(repos, c.req.param('project_id'));
    const endpoint = findEndpoint(repos, project, c.req.param('endpoint_id'));
    if (repos.operations.hasActiveFor({ endpoint_id: endpoint.id })) throw errors.runningOperations();
    const operations = [service.suspendEndpoint(endpoint), service.startEndpoint(endpoint)];
    return respond(c, 'EndpointOperations', {
      endpoint: endpointView(endpoint, context),
      operations: operationsView(operations),
    });
  });
}

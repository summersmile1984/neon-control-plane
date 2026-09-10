import type { Hono } from 'hono';
import type { AppDeps, AppEnv } from '../app.ts';
import { viewContext } from '../app.ts';
import { respond } from '../respond.ts';
import { errors } from '../errors.ts';
import { branchView, databaseView, endpointView, roleView } from '../../domain/views.ts';
import type { EndpointType } from '../../store/rows.ts';
import {
  checkRequest, decodePathSegment, findBranch, findDatabase, findProject, findRole, jsonBody,
  operationsView, optionalBoolean, optionalInteger, optionalString, pgIdentifier, requiredString, section,
} from './helpers.ts';

/** Branches, and the roles and databases that live on a branch (002 §4.1). */
export function registerBranchRoutes(api: Hono<AppEnv>, deps: AppDeps): void {
  const { repos, service, config } = deps;
  const context = viewContext(config);

  api.get('/projects/:project_id/branches', (c) => {
    const project = findProject(repos, c.req.param('project_id'));
    return respond(c, 'BranchesResponse', {
      branches: repos.branches.listByProject(project.id).map((row) => branchView(row, context)),
    });
  });

  api.post('/projects/:project_id/branches', async (c) => {
    const project = findProject(repos, c.req.param('project_id'));
    const body = await jsonBody(c);
    checkRequest('BranchCreateRequest', body);
    const branch = section(body, 'branch');

    const wanted = Array.isArray(body.endpoints) ? body.endpoints : [];
    const endpoints = wanted.map((entry) => {
      const item = entry as Record<string, unknown>;
      const type = requiredString(item, 'type');
      if (type !== 'read_write' && type !== 'read_only') throw errors.badRequest('endpoint type must be read_write or read_only');
      const suspend = optionalInteger(item, 'suspend_timeout_seconds');
      return { type: type as EndpointType, ...(suspend === undefined ? {} : { suspendTimeoutSeconds: suspend }) };
    });

    const created = await service.createBranch(project.id, {
      ...(optionalString(branch, 'name') === undefined ? {} : { name: optionalString(branch, 'name')! }),
      ...(optionalString(branch, 'parent_id') === undefined ? {} : { parentId: optionalString(branch, 'parent_id')! }),
      ...(optionalString(branch, 'parent_lsn') === undefined ? {} : { parentLsn: optionalString(branch, 'parent_lsn')! }),
      ...(optionalString(branch, 'parent_timestamp') === undefined ? {} : { parentTimestamp: optionalString(branch, 'parent_timestamp')! }),
      ...(optionalBoolean(branch, 'protected') === undefined ? {} : { protected: optionalBoolean(branch, 'protected')! }),
      ...(body.annotation_value ? { annotation: section(body, 'annotation_value') } : {}),
      ...(endpoints.length > 0 ? { endpoints } : {}),
    });

    return respond(c, 'responses:CreatedBranch', {
      branch: branchView(created.branch, context),
      endpoints: created.endpoints.map((row) => endpointView(row, context)),
      operations: operationsView(created.operations),
      roles: repos.roles.listByBranch(created.branch.id).map((row) => roleView(row)),
      databases: repos.databases.listByBranch(created.branch.id).map(databaseView),
    }, 201);
  });

  api.get('/projects/:project_id/branches/:branch_id', async (c) => {
    const project = findProject(repos, c.req.param('project_id'));
    const branch = findBranch(repos, project, c.req.param('branch_id'));
    await service.refreshBranchSize(project, branch);
    const fresh = repos.branches.get(branch.id) ?? branch;
    return respond(c, 'BranchResponse', { branch: branchView(fresh, context) });
  });

  api.patch('/projects/:project_id/branches/:branch_id', async (c) => {
    const project = findProject(repos, c.req.param('project_id'));
    const branch = findBranch(repos, project, c.req.param('branch_id'));
    const body = await jsonBody(c);
    checkRequest('BranchUpdateRequest', body);
    const patch = section(body, 'branch');
    const updated = repos.branches.update(branch.id, {
      ...(optionalString(patch, 'name') === undefined ? {} : { name: optionalString(patch, 'name')! }),
      ...(optionalBoolean(patch, 'protected') === undefined ? {} : { protected: optionalBoolean(patch, 'protected')! ? 1 : 0 }),
    });
    if (!updated) throw errors.branchNotFound(branch.id);
    return respond(c, 'BranchOperations', { branch: branchView(updated, context), operations: [] });
  });

  api.delete('/projects/:project_id/branches/:branch_id', (c) => {
    const project = findProject(repos, c.req.param('project_id'));
    const branch = findBranch(repos, project, c.req.param('branch_id'));
    const operation = service.deleteBranch(project.id, branch.id);
    return respond(c, 'BranchOperations', { branch: branchView(branch, context), operations: operationsView([operation]) });
  });

  api.post('/projects/:project_id/branches/:branch_id/set_as_default', (c) => {
    const project = findProject(repos, c.req.param('project_id'));
    const branch = findBranch(repos, project, c.req.param('branch_id'));
    const updated = repos.transaction(() => {
      repos.branches.clearDefault(project.id);
      repos.projects.update(project.id, { default_branch_id: branch.id });
      return repos.branches.update(branch.id, { is_default: 1 });
    });
    if (!updated) throw errors.branchNotFound(branch.id);
    return respond(c, 'BranchOperations', { branch: branchView(updated, context), operations: [] });
  });

  api.get('/projects/:project_id/branches/:branch_id/endpoints', (c) => {
    const project = findProject(repos, c.req.param('project_id'));
    const branch = findBranch(repos, project, c.req.param('branch_id'));
    return respond(c, 'EndpointsResponse', {
      endpoints: repos.endpoints.listByBranch(branch.id).map((row) => endpointView(row, context)),
    });
  });

  // ---- roles -------------------------------------------------------------------------------

  api.get('/projects/:project_id/branches/:branch_id/roles', (c) => {
    const project = findProject(repos, c.req.param('project_id'));
    const branch = findBranch(repos, project, c.req.param('branch_id'));
    return respond(c, 'RolesResponse', { roles: repos.roles.listByBranch(branch.id).map((row) => roleView(row)) });
  });

  api.post('/projects/:project_id/branches/:branch_id/roles', async (c) => {
    const project = findProject(repos, c.req.param('project_id'));
    const branch = findBranch(repos, project, c.req.param('branch_id'));
    const body = await jsonBody(c);
    checkRequest('RoleCreateRequest', body);
    const role = section(body, 'role');
    const name = pgIdentifier(requiredString(role, 'name'), 'role.name');
    const created = service.createRole(branch, name, optionalBoolean(role, 'no_login') ?? false);
    return respond(c, 'RoleOperations', {
      role: roleView(created.role, created.password),
      operations: operationsView(created.operations),
    }, 201);
  });

  api.get('/projects/:project_id/branches/:branch_id/roles/:role_name', (c) => {
    const project = findProject(repos, c.req.param('project_id'));
    const branch = findBranch(repos, project, c.req.param('branch_id'));
    const role = findRole(repos, branch, decodePathSegment(c.req.param('role_name'), 'role_name'));
    return respond(c, 'RoleResponse', { role: roleView(role) });
  });

  api.delete('/projects/:project_id/branches/:branch_id/roles/:role_name', (c) => {
    const project = findProject(repos, c.req.param('project_id'));
    const branch = findBranch(repos, project, c.req.param('branch_id'));
    const role = findRole(repos, branch, decodePathSegment(c.req.param('role_name'), 'role_name'));
    const result = service.deleteRole(branch, role);
    return respond(c, 'RoleOperations', { role: roleView(role), operations: operationsView(result.operations) });
  });

  api.post('/projects/:project_id/branches/:branch_id/roles/:role_name/reset_password', (c) => {
    const project = findProject(repos, c.req.param('project_id'));
    const branch = findBranch(repos, project, c.req.param('branch_id'));
    const role = findRole(repos, branch, decodePathSegment(c.req.param('role_name'), 'role_name'));
    const result = service.resetRolePassword(branch, role);
    return respond(c, 'RoleOperations', {
      role: roleView(result.role, result.password),
      operations: operationsView(result.operations),
    });
  });

  api.get('/projects/:project_id/branches/:branch_id/roles/:role_name/reveal_password', (c) => {
    const project = findProject(repos, c.req.param('project_id'));
    const branch = findBranch(repos, project, c.req.param('branch_id'));
    const role = findRole(repos, branch, decodePathSegment(c.req.param('role_name'), 'role_name'));
    return respond(c, 'RolePasswordResponse', { password: service.revealPassword(project, role) });
  });

  // ---- databases ---------------------------------------------------------------------------

  api.get('/projects/:project_id/branches/:branch_id/databases', (c) => {
    const project = findProject(repos, c.req.param('project_id'));
    const branch = findBranch(repos, project, c.req.param('branch_id'));
    return respond(c, 'DatabasesResponse', { databases: repos.databases.listByBranch(branch.id).map(databaseView) });
  });

  api.post('/projects/:project_id/branches/:branch_id/databases', async (c) => {
    const project = findProject(repos, c.req.param('project_id'));
    const branch = findBranch(repos, project, c.req.param('branch_id'));
    const body = await jsonBody(c);
    checkRequest('DatabaseCreateRequest', body);
    const database = section(body, 'database');
    const created = service.createDatabase(
      branch,
      pgIdentifier(requiredString(database, 'name'), 'database.name'),
      pgIdentifier(requiredString(database, 'owner_name'), 'database.owner_name'),
    );
    return respond(c, 'DatabaseOperations', {
      database: databaseView(created.database),
      operations: operationsView(created.operations),
    }, 201);
  });

  api.get('/projects/:project_id/branches/:branch_id/databases/:database_name', (c) => {
    const project = findProject(repos, c.req.param('project_id'));
    const branch = findBranch(repos, project, c.req.param('branch_id'));
    const database = findDatabase(repos, branch, decodePathSegment(c.req.param('database_name'), 'database_name'));
    return respond(c, 'DatabaseResponse', { database: databaseView(database) });
  });

  api.patch('/projects/:project_id/branches/:branch_id/databases/:database_name', async (c) => {
    const project = findProject(repos, c.req.param('project_id'));
    const branch = findBranch(repos, project, c.req.param('branch_id'));
    const database = findDatabase(repos, branch, decodePathSegment(c.req.param('database_name'), 'database_name'));
    const body = await jsonBody(c);
    checkRequest('DatabaseUpdateRequest', body);
    const patch = section(body, 'database');
    const result = service.updateDatabase(branch, database, {
      ...(optionalString(patch, 'name') === undefined ? {} : { name: pgIdentifier(optionalString(patch, 'name')!, 'database.name') }),
      ...(optionalString(patch, 'owner_name') === undefined ? {} : { ownerName: pgIdentifier(optionalString(patch, 'owner_name')!, 'database.owner_name') }),
    });
    return respond(c, 'DatabaseOperations', {
      database: databaseView(result.database),
      operations: operationsView(result.operations),
    });
  });

  api.delete('/projects/:project_id/branches/:branch_id/databases/:database_name', (c) => {
    const project = findProject(repos, c.req.param('project_id'));
    const branch = findBranch(repos, project, c.req.param('branch_id'));
    const database = findDatabase(repos, branch, decodePathSegment(c.req.param('database_name'), 'database_name'));
    const result = service.deleteDatabase(branch, database);
    return respond(c, 'DatabaseOperations', {
      database: databaseView(database),
      operations: operationsView(result.operations),
    });
  });
}

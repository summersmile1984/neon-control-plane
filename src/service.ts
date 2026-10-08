import { randomUUID } from 'node:crypto';
import type { Config } from './config.ts';
import type { Logger } from './logger.ts';
import type { Repositories } from './store/repo.ts';
import type { BranchRow, DatabaseRow, EndpointRow, EndpointType, OperationRow, ProjectRow, RoleRow } from './store/rows.ts';
import type { PageserverClient } from './adapters/pageserver.ts';
import { PageserverError } from './adapters/pageserver.ts';
import { generateBranchId, generateEndpointId, generateHexId, generateOperationId, generateProjectId } from './domain/ids.ts';
import { generatePassword, scramSha256 } from './domain/scram.ts';
import { openPassword, sealPassword } from './domain/secrets.ts';
import { buildConnectionUri, endpointHost, type ConnectionParameters, connectionParameters } from './domain/connection-uri.ts';
import type { DeltaOperation } from './domain/spec-builder.ts';
import { errors } from './http/errors.ts';

/**
 * Business layer between the routes and the stores (002 §5). Routes stay thin: they parse, call
 * one function here, and format the response through `respond`.
 *
 * Hard rule from 002 §1: a write persists its `operations` row inside the same transaction as the
 * state change, before any side effect runs.
 */

export const DEFAULT_BRANCH_NAME = 'main';
export const DEFAULT_ROLE_NAME = 'neondb_owner';
export const DEFAULT_DATABASE_NAME = 'neondb';
export const DEFAULT_PG_VERSION = 17;
export const DEFAULT_SUSPEND_TIMEOUT_SECONDS = 300;

export interface ServiceDeps {
  readonly repos: Repositories;
  readonly pageserver: PageserverClient;
  readonly config: Config;
  readonly logger: Logger;
}

export interface CreateProjectInput {
  readonly name?: string;
  readonly pgVersion?: number;
  readonly historyRetentionSeconds?: number;
  readonly storePasswords?: boolean;
  readonly settings?: Record<string, unknown>;
  readonly annotation?: Record<string, unknown>;
  readonly branchName?: string;
  readonly roleName?: string;
  readonly databaseName?: string;
  readonly withEndpoint?: boolean;
  /** Organization that owns the project (design 004). */
  readonly orgId?: string;
}

export interface CreatedProject {
  readonly project: ProjectRow;
  readonly branch: BranchRow;
  readonly role: RoleRow;
  readonly password: string;
  readonly database: DatabaseRow;
  readonly endpoint?: EndpointRow;
  readonly operations: OperationRow[];
}

export interface CreateBranchInput {
  readonly name?: string;
  readonly parentId?: string;
  readonly parentLsn?: string;
  readonly parentTimestamp?: string;
  readonly protected?: boolean;
  readonly annotation?: Record<string, unknown>;
  readonly endpoints?: ReadonlyArray<{ type: EndpointType; suspendTimeoutSeconds?: number }>;
}

export interface CreatedBranch {
  readonly branch: BranchRow;
  readonly endpoints: EndpointRow[];
  readonly operations: OperationRow[];
}

export interface Service {
  createProject(input: CreateProjectInput): Promise<CreatedProject>;
  deleteProject(projectId: string): OperationRow;
  createBranch(projectId: string, input: CreateBranchInput): Promise<CreatedBranch>;
  deleteBranch(projectId: string, branchId: string): OperationRow;
  createEndpoint(projectId: string, branchId: string, type: EndpointType, suspendTimeoutSeconds?: number, name?: string | null): { endpoint: EndpointRow; operations: OperationRow[] };
  deleteEndpoint(endpoint: EndpointRow): OperationRow[];
  startEndpoint(endpoint: EndpointRow): OperationRow;
  suspendEndpoint(endpoint: EndpointRow): OperationRow;
  createRole(branch: BranchRow, name: string, noLogin: boolean): { role: RoleRow; password: string; operations: OperationRow[] };
  resetRolePassword(branch: BranchRow, role: RoleRow): { role: RoleRow; password: string; operations: OperationRow[] };
  deleteRole(branch: BranchRow, role: RoleRow): { operations: OperationRow[] };
  revealPassword(project: ProjectRow, role: RoleRow): string;
  createDatabase(branch: BranchRow, name: string, ownerName: string): { database: DatabaseRow; operations: OperationRow[] };
  updateDatabase(branch: BranchRow, database: DatabaseRow, patch: { name?: string; ownerName?: string }): { database: DatabaseRow; operations: OperationRow[] };
  deleteDatabase(branch: BranchRow, database: DatabaseRow): { operations: OperationRow[] };
  connectionUri(project: ProjectRow, branch: BranchRow, endpoint: EndpointRow, databaseName: string, roleName: string, pooled: boolean): { uri: string; parameters: ConnectionParameters };
  allocatePorts(): { pgPort: number; httpPort: number };
  refreshBranchSize(project: ProjectRow, branch: BranchRow): Promise<void>;
}

export function createService(deps: ServiceDeps): Service {
  const { repos, pageserver, config } = deps;

  function allocatePorts(): { pgPort: number; httpPort: number } {
    const [low, high] = config.portRange;
    const used = new Set(repos.endpoints.usedPorts());
    const free: number[] = [];
    for (let port = low; port <= high && free.length < 2; port += 1) if (!used.has(port)) free.push(port);
    if (free.length < 2) throw errors.internal('no free ports left in CP_PORT_RANGE');
    return { pgPort: free[0]!, httpPort: free[1]! };
  }

  function queueApplyConfig(branch: BranchRow, deltaOperations: DeltaOperation[] = []): OperationRow[] {
    // A starting compute may already have captured its spec. Queue behind its
    // start operation as well, or a concurrent role/database create is lost
    // from the live catalog until a later restart. Operations serialize by branch.
    const endpoints = repos.endpoints.listByBranch(branch.id);
    if (endpoints.length === 0 && deltaOperations.length === 0) return [];
    return [repos.operations.insert({
      id: generateOperationId(),
      project_id: branch.project_id,
      branch_id: branch.id,
      action: 'apply_config',
      payload: { branch_id: branch.id, delta_operations: deltaOperations },
    })];
  }

  function newEndpointRow(project: ProjectRow, branch: BranchRow, type: EndpointType, suspendTimeoutSeconds: number, name: string | null = null): EndpointRow {
    const id = generateEndpointId();
    const ports = allocatePorts();
    return repos.endpoints.insert({
      id,
      project_id: project.id,
      branch_id: branch.id,
      name,
      type,
      current_state: 'init',
      host: endpointHost(config.routeMode, config.zone, id),
      pg_port: ports.pgPort,
      http_port: ports.httpPort,
      suspend_timeout_seconds: suspendTimeoutSeconds,
      autoscaling_min_cu: 0.25,
      autoscaling_max_cu: 0.25,
      settings_json: '{}',
      disabled: 0,
    });
  }

  async function resolveAncestorLsn(project: ProjectRow, parent: BranchRow, input: CreateBranchInput): Promise<string | undefined> {
    if (input.parentLsn) return input.parentLsn;
    if (!input.parentTimestamp) return undefined;
    const answer = await pageserver.getLsnByTimestamp(project.tenant_id, parent.timeline_id, input.parentTimestamp);
    const lsn = typeof answer.lsn === 'string' ? answer.lsn : undefined;
    if (!lsn) throw errors.wrongLsnOrTimestamp(`no LSN for ${input.parentTimestamp}`);
    // The pageserver answers out-of-range timestamps instead of failing, so compare against the
    // readable window ourselves (docs/notes/M0-pageserver-findings.md).
    const detail = await pageserver.getTimeline(project.tenant_id, parent.timeline_id);
    const floor = typeof detail.min_readable_lsn === 'string' ? detail.min_readable_lsn : undefined;
    if (floor && compareLsn(lsn, floor) < 0) {
      throw errors.wrongLsnOrTimestamp(`${input.parentTimestamp} is older than the retained history of branch ${parent.id}`);
    }
    return lsn;
  }

  return {
    allocatePorts,

    async createProject(input) {
      const pgVersion = input.pgVersion ?? DEFAULT_PG_VERSION;
      if (!Number.isInteger(pgVersion) || pgVersion < 14 || pgVersion > 18) throw errors.badRequest('pg_version must be between 14 and 18');

      const tenantId = generateHexId();
      const timelineId = generateHexId();
      const projectId = generateProjectId();
      const branchId = generateBranchId();
      const historyRetentionSeconds = input.historyRetentionSeconds ?? 604_800;

      // Storage first: if the pageserver refuses, nothing is persisted.
      await pageserver.locationConfig(tenantId, {
        mode: 'AttachedSingle',
        generation: 1,
        tenant_conf: { pitr_interval: `${historyRetentionSeconds}s` },
      });
      const timeline = await pageserver.createTimeline(tenantId, { new_timeline_id: timelineId, pg_version: pgVersion });

      const password = generatePassword();
      const roleName = input.roleName ?? DEFAULT_ROLE_NAME;
      const databaseName = input.databaseName ?? DEFAULT_DATABASE_NAME;

      return repos.transaction(() => {
        const project = repos.projects.insert({
          id: projectId,
          tenant_id: tenantId,
          name: input.name ?? projectId,
          pg_version: pgVersion,
          region_id: 'local',
          platform_id: 'local',
          provisioner: 'k8s-pod',
          store_passwords: input.storePasswords === false ? 0 : 1,
          history_retention_seconds: historyRetentionSeconds,
          default_branch_id: branchId,
          settings_json: JSON.stringify(input.settings ?? {}),
          annotation_json: JSON.stringify(input.annotation ?? {}),
          org_id: input.orgId ?? null,
        });

        const branch = repos.branches.insert({
          id: branchId,
          project_id: project.id,
          timeline_id: timelineId,
          name: input.branchName ?? DEFAULT_BRANCH_NAME,
          parent_id: null,
          parent_lsn: null,
          parent_timestamp: null,
          is_default: 1,
          protected: 0,
          current_state: 'ready',
          pending_state: null,
          logical_size: typeof timeline.current_logical_size === 'number' ? timeline.current_logical_size : null,
          annotation_json: JSON.stringify(input.annotation ?? {}),
        });

        const role = repos.roles.upsert({
          branch_id: branch.id,
          name: roleName,
          password_ciphertext: sealPassword(password, config.masterKey),
          scram_secret: scramSha256(password),
          protected: 0,
          no_login: 0,
        });
        const database = repos.databases.insert({ branch_id: branch.id, name: databaseName, owner_name: roleName });

        const operations: OperationRow[] = [
          repos.operations.insert({
            id: generateOperationId(), project_id: project.id, branch_id: branch.id,
            action: 'create_timeline', payload: { timeline_id: timelineId }, status: 'finished',
          }),
        ];

        let endpoint: EndpointRow | undefined;
        if (input.withEndpoint !== false) {
          endpoint = newEndpointRow(project, branch, 'read_write', DEFAULT_SUSPEND_TIMEOUT_SECONDS);
          operations.push(repos.operations.insert({
            id: generateOperationId(), project_id: project.id, branch_id: branch.id, endpoint_id: endpoint.id,
            action: 'start_compute', payload: { endpoint_id: endpoint.id },
          }));
        }

        return { project, branch, role, password, database, operations, ...(endpoint ? { endpoint } : {}) };
      });
    },

    deleteProject(projectId) {
      const project = repos.projects.get(projectId);
      if (!project) throw errors.projectNotFound(projectId);
      return repos.operations.insert({
        id: generateOperationId(), project_id: project.id, action: 'tenant_detach',
        payload: { tenant_id: project.tenant_id },
      });
    },

    async createBranch(projectId, input) {
      const project = repos.projects.get(projectId);
      if (!project) throw errors.projectNotFound(projectId);

      const parentId = input.parentId ?? project.default_branch_id;
      if (!parentId) throw errors.badRequest('project has no default branch to fork from');
      const parent = repos.branches.get(parentId);
      if (!parent) throw errors.branchNotFound(parentId);

      const name = input.name ?? `br-${randomUUID().slice(0, 8)}`;
      if (repos.branches.getByName(project.id, name)) throw errors.alreadyExists(`branch ${name}`);

      const ancestorStartLsn = await resolveAncestorLsn(project, parent, input);
      const branchId = generateBranchId();
      const timelineId = generateHexId();
      const timeline = await pageserver.createTimeline(project.tenant_id, {
        new_timeline_id: timelineId,
        ancestor_timeline_id: parent.timeline_id,
        ...(ancestorStartLsn ? { ancestor_start_lsn: ancestorStartLsn } : {}),
      });

      return repos.transaction(() => {
        const branch = repos.branches.insert({
          id: branchId,
          project_id: project.id,
          timeline_id: timelineId,
          name,
          parent_id: parent.id,
          parent_lsn: (typeof timeline.ancestor_lsn === 'string' ? timeline.ancestor_lsn : ancestorStartLsn) ?? null,
          parent_timestamp: input.parentTimestamp ?? null,
          is_default: 0,
          protected: input.protected ? 1 : 0,
          current_state: 'ready',
          pending_state: null,
          logical_size: typeof timeline.current_logical_size === 'number' ? timeline.current_logical_size : null,
          annotation_json: JSON.stringify(input.annotation ?? {}),
        });

        const operations: OperationRow[] = [repos.operations.insert({
          id: generateOperationId(), project_id: project.id, branch_id: branch.id,
          action: 'create_branch', payload: { timeline_id: timelineId }, status: 'finished',
        })];

        const endpoints: EndpointRow[] = [];
        for (const wanted of input.endpoints ?? []) {
          const endpoint = newEndpointRow(project, branch, wanted.type, wanted.suspendTimeoutSeconds ?? DEFAULT_SUSPEND_TIMEOUT_SECONDS);
          endpoints.push(endpoint);
          operations.push(repos.operations.insert({
            id: generateOperationId(), project_id: project.id, branch_id: branch.id, endpoint_id: endpoint.id,
            action: 'start_compute', payload: { endpoint_id: endpoint.id },
          }));
        }
        return { branch, endpoints, operations };
      });
    },

    deleteBranch(projectId, branchId) {
      const branch = repos.branches.get(branchId);
      if (!branch || branch.project_id !== projectId) throw errors.branchNotFound(branchId);
      if (branch.is_default) throw errors.badRequest('the default branch cannot be deleted');
      if (branch.protected) throw errors.badRequest('a protected branch cannot be deleted');
      if (repos.branches.listChildren(branch.id).length > 0) throw errors.badRequest('branch has child branches');
      return repos.operations.insert({
        id: generateOperationId(), project_id: projectId, branch_id: branch.id, action: 'delete_timeline',
        payload: { branch_id: branch.id, timeline_id: branch.timeline_id },
      });
    },

    createEndpoint(projectId, branchId, type, suspendTimeoutSeconds, name) {
      const project = repos.projects.get(projectId);
      if (!project) throw errors.projectNotFound(projectId);
      const branch = repos.branches.get(branchId);
      if (!branch || branch.project_id !== projectId) throw errors.branchNotFound(branchId);
      if (type === 'read_write' && repos.endpoints.readWriteFor(branch.id)) {
        throw errors.alreadyExists(`a read_write endpoint on branch ${branch.id}`);
      }
      return repos.transaction(() => {
        const endpoint = newEndpointRow(project, branch, type, suspendTimeoutSeconds ?? DEFAULT_SUSPEND_TIMEOUT_SECONDS, name ?? null);
        const operations = [repos.operations.insert({
          id: generateOperationId(), project_id: project.id, branch_id: branch.id, endpoint_id: endpoint.id,
          action: 'start_compute', payload: { endpoint_id: endpoint.id },
        })];
        return { endpoint, operations };
      });
    },

    deleteEndpoint(endpoint) {
      return repos.transaction(() => {
        const operations = [repos.operations.insert({
          id: generateOperationId(), project_id: endpoint.project_id, branch_id: endpoint.branch_id,
          endpoint_id: endpoint.id, action: 'suspend_compute', payload: { endpoint_id: endpoint.id },
        })];
        repos.endpoints.softDelete(endpoint.id);
        return operations;
      });
    },

    startEndpoint(endpoint) {
      return repos.operations.insert({
        id: generateOperationId(), project_id: endpoint.project_id, branch_id: endpoint.branch_id,
        endpoint_id: endpoint.id, action: 'start_compute', payload: { endpoint_id: endpoint.id },
      });
    },

    suspendEndpoint(endpoint) {
      return repos.operations.insert({
        id: generateOperationId(), project_id: endpoint.project_id, branch_id: endpoint.branch_id,
        endpoint_id: endpoint.id, action: 'suspend_compute', payload: { endpoint_id: endpoint.id },
      });
    },

    createRole(branch, name, noLogin) {
      if (repos.roles.get(branch.id, name)) throw errors.alreadyExists(`role ${name}`);
      const password = generatePassword();
      return repos.transaction(() => {
        const role = repos.roles.upsert({
          branch_id: branch.id, name,
          password_ciphertext: sealPassword(password, config.masterKey),
          scram_secret: scramSha256(password),
          protected: 0, no_login: noLogin ? 1 : 0,
        });
        return { role, password, operations: queueApplyConfig(branch) };
      });
    },

    resetRolePassword(branch, role) {
      const password = generatePassword();
      return repos.transaction(() => {
        const updated = repos.roles.setPassword(branch.id, role.name, sealPassword(password, config.masterKey), scramSha256(password));
        if (!updated) throw errors.roleNotFound(role.name);
        return { role: updated, password, operations: queueApplyConfig(branch) };
      });
    },

    deleteRole(branch, role) {
      if (role.protected) throw errors.badRequest(`role ${role.name} is protected`);
      const owned = repos.databases.ownedBy(branch.id, role.name);
      if (owned.length > 0) throw errors.badRequest(`role ${role.name} owns ${owned.map((row) => row.name).join(', ')}`);
      return repos.transaction(() => {
        repos.roles.remove(branch.id, role.name);
        // Dropping the role from the spec is not enough: compute_ctl only removes it when told to
        // (docs/notes/M0-compute-findings.md).
        return { operations: queueApplyConfig(branch, [{ action: 'delete_role', name: role.name }]) };
      });
    },

    revealPassword(project, role) {
      if (!project.store_passwords) throw errors.preconditionFailed('this project does not store role passwords');
      if (!role.password_ciphertext) throw errors.preconditionFailed(`no stored password for role ${role.name}`);
      return openPassword(role.password_ciphertext, config.masterKey);
    },

    createDatabase(branch, name, ownerName) {
      if (repos.databases.get(branch.id, name)) throw errors.alreadyExists(`database ${name}`);
      if (!repos.roles.get(branch.id, ownerName)) throw errors.roleNotFound(ownerName);
      return repos.transaction(() => {
        const database = repos.databases.insert({ branch_id: branch.id, name, owner_name: ownerName });
        return { database, operations: queueApplyConfig(branch) };
      });
    },

    updateDatabase(branch, database, patch) {
      if (patch.ownerName && !repos.roles.get(branch.id, patch.ownerName)) throw errors.roleNotFound(patch.ownerName);
      return repos.transaction(() => {
        const updated = repos.databases.rename(branch.id, database.name, {
          ...(patch.name ? { name: patch.name } : {}),
          ...(patch.ownerName ? { owner_name: patch.ownerName } : {}),
        });
        if (!updated) throw errors.databaseNotFound(database.name);
        const deltas: DeltaOperation[] = patch.name && patch.name !== database.name
          ? [{ action: 'rename_db', name: database.name, new_name: patch.name }]
          : [];
        return { database: updated, operations: queueApplyConfig(branch, deltas) };
      });
    },

    deleteDatabase(branch, database) {
      return repos.transaction(() => {
        repos.databases.remove(branch.id, database.name);
        return { operations: queueApplyConfig(branch, [{ action: 'delete_db', name: database.name }]) };
      });
    },

    connectionUri(project, branch, endpoint, databaseName, roleName, pooled) {
      const database = repos.databases.get(branch.id, databaseName);
      if (!database) throw errors.databaseNotFound(databaseName);
      const role = repos.roles.get(branch.id, roleName);
      if (!role) throw errors.roleNotFound(roleName);
      if (!role.password_ciphertext) throw errors.preconditionFailed(`no stored password for role ${roleName}`);
      void project;
      const input = {
        mode: config.routeMode,
        zone: config.zone,
        endpoint: { id: endpoint.id, pgPort: endpoint.pg_port },
        database: database.name,
        role: role.name,
        password: openPassword(role.password_ciphertext, config.masterKey),
        pooled,
      };
      return { uri: buildConnectionUri(input), parameters: connectionParameters(input) };
    },

    async refreshBranchSize(project, branch) {
      try {
        const detail = await pageserver.getTimeline(project.tenant_id, branch.timeline_id);
        if (typeof detail.current_logical_size === 'number') {
          repos.branches.update(branch.id, { logical_size: detail.current_logical_size });
        }
      } catch (error) {
        if (error instanceof PageserverError && error.kind === 'not_found') return;
        deps.logger.warn('could not refresh branch size', { branch_id: branch.id });
      }
    },
  };
}

/** Compares `X/Y` hex LSNs. */
export function compareLsn(left: string, right: string): number {
  const parse = (value: string): bigint => {
    const [high = '0', low = '0'] = value.split('/');
    return (BigInt(`0x${high}`) << 32n) + BigInt(`0x${low}`);
  };
  const a = parse(left);
  const b = parse(right);
  return a === b ? 0 : a < b ? -1 : 1;
}

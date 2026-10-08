import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildComputeSpec, COMPUTE_PG_PORT, type DeltaOperation } from '../domain/spec-builder.ts';
import { PageserverError } from '../adapters/pageserver.ts';
import type { ComputeTarget } from '../adapters/compute.ts';
import type { BranchRow, EndpointRow, ProjectRow } from '../store/rows.ts';
import { type ActionDefinition, type OperationStep, type StepContext, step } from './types.ts';

/**
 * Operation actions (002 §5.4/§5.5). Each step is idempotent; the loop persists `cursor_step`
 * after every success so a restart resumes rather than repeats side effects it already applied.
 */

const COMPUTE_HTTP_PORT = 3080;
export const LABEL_ENDPOINT = 'neon-cp.endpoint_id';
export const LABEL_PROJECT = 'neon-cp.project_id';
export const LABEL_INSTANCE = 'neon-cp.instance_id';

function requireProject(context: StepContext, projectId: string): ProjectRow {
  const project = context.repos.projects.get(projectId);
  if (!project) throw new Error(`project ${projectId} is gone`);
  return project;
}

function requireBranch(context: StepContext, branchId: string): BranchRow {
  const branch = context.repos.branches.get(branchId);
  if (!branch) throw new Error(`branch ${branchId} is gone`);
  return branch;
}

function requireEndpoint(context: StepContext, endpointId: string): EndpointRow {
  const endpoint = context.repos.endpoints.get(endpointId);
  if (!endpoint) throw new Error(`endpoint ${endpointId} is gone`);
  return endpoint;
}

export function computeTarget(endpoint: EndpointRow): ComputeTarget {
  return { baseUrl: `http://127.0.0.1:${endpoint.http_port}`, computeId: endpoint.id };
}

export function specDirectory(root: string, endpointId: string): string {
  return resolve(join(root, endpointId, 'spec'));
}

/** Writes the spec the container mounts. Idempotent: same input, same file. */
export function writeSpecFile(context: StepContext, endpoint: EndpointRow, deltaOperations?: readonly DeltaOperation[]): string {
  const project = requireProject(context, endpoint.project_id);
  const branch = requireBranch(context, endpoint.branch_id);
  const envelope = buildComputeSpec({
    project,
    branch,
    endpoint,
    roles: context.repos.roles.listByBranch(branch.id),
    databases: context.repos.databases.listByBranch(branch.id),
    storage: {
      pageserverConnstring: context.config.pageserverConnstring,
      safekeeperConnstrings: context.config.safekeepers,
    },
    signer: context.signer,
    ...(deltaOperations && deltaOperations.length > 0 ? { deltaOperations } : {}),
    operationUuid: context.operation.id,
  });
  const directory = specDirectory(context.config.computeVolumeRoot, endpoint.id);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'config.json'), JSON.stringify(envelope, null, 2));
  return directory;
}

const startCompute: OperationStep[] = [
  step('write_spec', async (context) => {
    const endpoint = requireEndpoint(context, String(context.payload.endpoint_id));
    writeSpecFile(context, endpoint);
  }),

  step('ensure_container', async (context) => {
    const endpoint = requireEndpoint(context, String(context.payload.endpoint_id));
    const project = requireProject(context, endpoint.project_id);
    await context.docker.ensureNetwork(context.config.dockerNetwork);
    const created = await context.docker.createContainer({
      name: endpoint.id,
      image: `${context.config.computeImageRepo}/compute-node-v${project.pg_version}:${context.config.neonTag}`,
      entrypoint: ['/usr/local/bin/compute_ctl'],
      cmd: [
        '--pgdata', '/var/db/postgres/compute',
        '-C', `postgresql://cloud_admin@localhost:${COMPUTE_PG_PORT}/postgres`,
        '-b', '/usr/local/bin/postgres',
        '--compute-id', endpoint.id,
        '--config', '/spec/config.json',
        // Required outside a NeonVM: without it compute_ctl attempts VM-only operations.
        '--dev',
      ],
      binds: [`${specDirectory(context.config.computeVolumeRoot, endpoint.id)}:/spec:ro`],
      network: context.config.dockerNetwork,
      portBindings: {
        [`${COMPUTE_PG_PORT}/tcp`]: endpoint.pg_port,
        [`${COMPUTE_HTTP_PORT}/tcp`]: endpoint.http_port,
      },
      labels: {
        [LABEL_ENDPOINT]: endpoint.id, [LABEL_PROJECT]: endpoint.project_id,
        ...(context.config.instanceId ? { [LABEL_INSTANCE]: context.config.instanceId } : {}),
      },
    });
    context.repos.endpoints.update(endpoint.id, { container_id: created.id });
  }),

  step('start_container', async (context) => {
    const endpoint = requireEndpoint(context, String(context.payload.endpoint_id));
    await context.docker.startContainer(endpoint.container_id ?? endpoint.id);
  }),

  step('await_ready', async (context) => {
    const endpoint = requireEndpoint(context, String(context.payload.endpoint_id));
    await context.compute.waitForStatus(computeTarget(endpoint), 'running', 120_000);
  }),

  step('mark_active', async (context) => {
    const endpoint = requireEndpoint(context, String(context.payload.endpoint_id));
    context.repos.endpoints.setState(endpoint.id, 'active');
    context.repos.endpoints.touchActivity(endpoint.id);
    context.repos.branches.setState(endpoint.branch_id, 'ready');
  }),
];

const suspendCompute: OperationStep[] = [
  step('terminate_compute', async (context) => {
    const endpoint = requireEndpoint(context, String(context.payload.endpoint_id));
    if (endpoint.current_state === 'idle') return;
    await context.compute.terminate(computeTarget(endpoint), 'fast').catch(() => undefined);
  }),

  step('stop_container', async (context) => {
    const endpoint = requireEndpoint(context, String(context.payload.endpoint_id));
    await context.docker.stopContainer(endpoint.container_id ?? endpoint.id, 15);
  }),

  step('mark_idle', async (context) => {
    const endpoint = requireEndpoint(context, String(context.payload.endpoint_id));
    context.repos.endpoints.setState(endpoint.id, 'idle');
  }),
];

const applyConfig: OperationStep[] = [
  step('configure_active_endpoints', async (context) => {
    const branchId = String(context.payload.branch_id);
    const deltaOperations = (context.payload.delta_operations ?? []) as DeltaOperation[];
    const endpoints = context.repos.endpoints.listByBranch(branchId).filter((row) => row.current_state === 'active');
    for (const endpoint of endpoints) {
      const envelopePath = writeSpecFile(context, endpoint, deltaOperations);
      void envelopePath;
      const spec = buildComputeSpec({
        project: requireProject(context, endpoint.project_id),
        branch: requireBranch(context, endpoint.branch_id),
        endpoint,
        roles: context.repos.roles.listByBranch(branchId),
        databases: context.repos.databases.listByBranch(branchId),
        storage: { pageserverConnstring: context.config.pageserverConnstring, safekeeperConnstrings: context.config.safekeepers },
        signer: context.signer,
        ...(deltaOperations.length > 0 ? { deltaOperations } : {}),
        operationUuid: context.operation.id,
      });
      await context.compute.configure(computeTarget(endpoint), spec);
    }
  }),

  step('rewrite_spec_without_deltas', async (context) => {
    // A delta is a one-shot instruction: leave the on-disk spec clean so a restart does not replay it.
    const branchId = String(context.payload.branch_id);
    for (const endpoint of context.repos.endpoints.listByBranch(branchId)) writeSpecFile(context, endpoint);
  }),
];

const deleteTimeline: OperationStep[] = [
  step('remove_endpoint_containers', async (context) => {
    const branchId = String(context.payload.branch_id);
    for (const endpoint of context.repos.endpoints.listByBranch(branchId)) {
      await context.docker.removeContainer(endpoint.container_id ?? endpoint.id, true);
      context.repos.endpoints.softDelete(endpoint.id);
    }
  }),

  step('delete_timeline', async (context) => {
    const project = requireProject(context, context.operation.project_id);
    const timelineId = String(context.payload.timeline_id);
    try {
      await context.pageserver.deleteTimeline(project.tenant_id, timelineId);
    } catch (error) {
      if (error instanceof PageserverError && error.kind === 'not_found') return;
      throw error;
    }
  }),

  step('await_timeline_gone', async (context) => {
    const project = requireProject(context, context.operation.project_id);
    const timelineId = String(context.payload.timeline_id);
    // Deletion is asynchronous on the pageserver (measured: gone within ~0.5 s).
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const timelines = await context.pageserver.listTimelines(project.tenant_id).catch(() => []);
      if (!timelines.some((timeline) => timeline.timeline_id === timelineId)) return;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(`timeline ${timelineId} still present after delete`);
  }),

  step('mark_branch_deleted', async (context) => {
    const branchId = String(context.payload.branch_id);
    if (context.repos.branches.get(branchId)) context.repos.branches.softDelete(branchId);
  }),
];

const detachTenant: OperationStep[] = [
  step('remove_project_containers', async (context) => {
    const projectId = context.operation.project_id;
    for (const container of await context.docker.listByLabel(LABEL_PROJECT, projectId)) {
      await context.docker.removeContainer(container.id, true);
    }
    for (const endpoint of context.repos.endpoints.listByProject(projectId)) context.repos.endpoints.softDelete(endpoint.id);
  }),

  step('delete_tenant', async (context) => {
    const tenantId = String(context.payload.tenant_id);
    try {
      await context.pageserver.deleteTenant(tenantId);
    } catch (error) {
      if (error instanceof PageserverError && error.kind === 'not_found') return;
      throw error;
    }
  }),

  step('mark_project_deleted', async (context) => {
    const projectId = context.operation.project_id;
    for (const branch of context.repos.branches.listByProject(projectId)) context.repos.branches.softDelete(branch.id);
    if (context.repos.projects.get(projectId)) context.repos.projects.softDelete(projectId);
  }),
];

export const ACTIONS: readonly ActionDefinition[] = [
  { action: 'start_compute', steps: () => startCompute },
  { action: 'suspend_compute', steps: () => suspendCompute },
  { action: 'apply_config', steps: () => applyConfig },
  { action: 'delete_timeline', steps: () => deleteTimeline },
  { action: 'tenant_detach', steps: () => detachTenant },
];

export function stepsFor(action: string, payload: Record<string, unknown>): OperationStep[] {
  const definition = ACTIONS.find((candidate) => candidate.action === action);
  if (!definition) throw new Error(`no steps registered for action ${action}`);
  return definition.steps(payload);
}

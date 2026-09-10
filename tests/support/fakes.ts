import { PageserverError, type PageserverClient, type TimelineInfo } from '../../src/adapters/pageserver.ts';
import type { ContainerInfo, DockerClient } from '../../src/adapters/docker.ts';
import type { ComputeClient, ComputeStatusResponse } from '../../src/adapters/compute.ts';
import type { ComputeSpecEnvelope } from '../../src/domain/spec-builder.ts';

/**
 * In-memory stand-ins for the three adapters, shaped by what the real ones actually do
 * (docs/notes/M0-*-findings.md): creating the same timeline twice succeeds, deletes are visible
 * immediately here, and compute status flips to `running` once the container is started.
 */

export interface FakeState {
  tenants: Set<string>;
  timelines: Map<string, { tenant: string; ancestor?: string; ancestorLsn?: string }>;
  containers: Map<string, { id: string; running: boolean; labels: Record<string, string> }>;
  specs: ComputeSpecEnvelope[];
  configureCalls: Array<{ computeId: string; spec: ComputeSpecEnvelope }>;
  createCalls: number;
  lsnForTimestamp: string;
  lastRecordLsn: string;
  minReadableLsn: string;
  failComputeStatus: boolean;
}

export interface FakeAdapters {
  readonly state: FakeState;
  readonly pageserver: PageserverClient;
  readonly docker: DockerClient;
  readonly compute: ComputeClient;
}

export function fakeAdapters(): FakeAdapters {
  const state: FakeState = {
    tenants: new Set(),
    timelines: new Map(),
    containers: new Map(),
    specs: [],
    configureCalls: [],
    createCalls: 0,
    lsnForTimestamp: '0/14E8F98',
    lastRecordLsn: '0/14E8F98',
    minReadableLsn: '0/14E8F20',
    failComputeStatus: false,
  };

  const timelineInfo = (timelineId: string): TimelineInfo => {
    const entry = state.timelines.get(timelineId)!;
    return {
      timeline_id: timelineId,
      tenant_id: entry.tenant,
      ...(entry.ancestor ? { ancestor_timeline_id: entry.ancestor } : {}),
      // The real pageserver reports the branch point even when the request omitted it (it takes
      // the parent's tip), so mirror that here.
      ...(entry.ancestor ? { ancestor_lsn: entry.ancestorLsn ?? state.lastRecordLsn } : {}),
      last_record_lsn: state.lastRecordLsn,
      min_readable_lsn: state.minReadableLsn,
      current_logical_size: 23_027_712,
    };
  };

  const pageserver: PageserverClient = {
    status: async () => ({ id: 1234 }),
    listTenants: async () => [...state.tenants].map((id) => ({ id })),
    locationConfig: async (tenantId, body) => {
      if (body.mode === 'Detached') state.tenants.delete(tenantId);
      else state.tenants.add(tenantId);
    },
    deleteTenant: async (tenantId) => {
      if (!state.tenants.has(tenantId)) throw new PageserverError('not_found', 'no such tenant', 404);
      state.tenants.delete(tenantId);
      for (const [id, entry] of state.timelines) if (entry.tenant === tenantId) state.timelines.delete(id);
    },
    listTimelines: async (tenantId) => {
      if (!state.tenants.has(tenantId)) throw new PageserverError('not_found', 'no such tenant', 404);
      return [...state.timelines].filter(([, entry]) => entry.tenant === tenantId).map(([id]) => timelineInfo(id));
    },
    createTimeline: async (tenantId, body) => {
      if (!state.tenants.has(tenantId)) throw new PageserverError('not_found', 'no such tenant', 404);
      // Measured: recreating the same timeline id is accepted, so this stays idempotent.
      state.timelines.set(body.new_timeline_id, {
        tenant: tenantId,
        ...(body.ancestor_timeline_id ? { ancestor: body.ancestor_timeline_id } : {}),
        ...(body.ancestor_start_lsn ? { ancestorLsn: body.ancestor_start_lsn } : {}),
      });
      return timelineInfo(body.new_timeline_id);
    },
    getTimeline: async (tenantId, timelineId) => {
      const entry = state.timelines.get(timelineId);
      if (!entry || entry.tenant !== tenantId) throw new PageserverError('not_found', 'no such timeline', 404);
      return timelineInfo(timelineId);
    },
    deleteTimeline: async (tenantId, timelineId) => {
      const entry = state.timelines.get(timelineId);
      if (!entry || entry.tenant !== tenantId) throw new PageserverError('not_found', 'no such timeline', 404);
      state.timelines.delete(timelineId);
    },
    getLsnByTimestamp: async () => ({ lsn: state.lsnForTimestamp, kind: 'present' }),
  };

  const info = (name: string): ContainerInfo | undefined => {
    const entry = state.containers.get(name);
    return entry ? { id: entry.id, name, running: entry.running, labels: entry.labels } : undefined;
  };

  const docker: DockerClient = {
    ping: async () => true,
    ensureNetwork: async () => undefined,
    createContainer: async (spec) => {
      const existing = state.containers.get(spec.name);
      if (existing) return { id: existing.id, created: false };
      state.createCalls += 1;
      const id = `container_${spec.name}`;
      state.containers.set(spec.name, { id, running: false, labels: { ...spec.labels } });
      return { id, created: true };
    },
    startContainer: async (idOrName) => {
      const name = [...state.containers.keys()].find((key) => key === idOrName || state.containers.get(key)?.id === idOrName);
      if (!name) throw new Error(`no such container ${idOrName}`);
      state.containers.get(name)!.running = true;
    },
    stopContainer: async (idOrName) => {
      const name = [...state.containers.keys()].find((key) => key === idOrName || state.containers.get(key)?.id === idOrName);
      if (name) state.containers.get(name)!.running = false;
    },
    removeContainer: async (idOrName) => {
      const name = [...state.containers.keys()].find((key) => key === idOrName || state.containers.get(key)?.id === idOrName);
      if (name) state.containers.delete(name);
    },
    inspect: async (idOrName) => {
      const name = [...state.containers.keys()].find((key) => key === idOrName || state.containers.get(key)?.id === idOrName);
      return name ? info(name) : undefined;
    },
    listByLabel: async (label, value) => [...state.containers.keys()]
      .map((name) => info(name)!)
      .filter((container) => (value === undefined ? label in container.labels : container.labels[label] === value)),
    logs: async () => '',
  };

  const status = (computeId: string): ComputeStatusResponse => {
    const container = state.containers.get(computeId);
    return { status: container?.running ? 'running' : 'init' };
  };

  const compute: ComputeClient = {
    status: async (target) => {
      if (state.failComputeStatus) throw new Error('compute unreachable');
      return status(target.computeId);
    },
    waitForStatus: async (target, wanted) => {
      if (state.failComputeStatus) throw new Error(`compute did not reach ${wanted}`);
      const current = status(target.computeId);
      if (current.status !== wanted) throw new Error(`compute is ${current.status}, wanted ${wanted}`);
      return current;
    },
    configure: async (target, spec) => {
      state.configureCalls.push({ computeId: target.computeId, spec });
      state.specs.push(spec);
      return status(target.computeId);
    },
    terminate: async (target) => {
      const container = state.containers.get(target.computeId);
      if (container) container.running = false;
    },
    dbsAndRoles: async () => ({ roles: [], databases: [] }),
  };

  return { state, pageserver, docker, compute };
}

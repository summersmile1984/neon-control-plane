import { randomUUID } from 'node:crypto';
import type { BranchRow, DatabaseRow, EndpointRow, ProjectRow, RoleRow } from '../store/rows.ts';
import type { ComputeSigner } from './compute-auth.ts';

/**
 * ComputeSpec assembly (002 §8) — the most version-sensitive part of the control plane.
 *
 * Measured against compute-node-v17 build 8464 on 2026-09-07 (docs/notes/M0-compute-findings.md):
 *   - `compute_ctl_config.jwks` is mandatory: without it the config file does not even parse.
 *   - Storage wiring works through the top-level fields, through the `neon.*` GUCs, or both.
 *     Both are written here: the top-level fields are what the real control plane sends, the GUCs
 *     are what the official docker-compose exercises in CI.
 *   - Roles and databases in `cluster` are created on start, but removing one from the spec does
 *     NOT drop it — deletion must go through `delta_operations`.
 */

export type DeltaAction = 'delete_role' | 'delete_db' | 'rename_role' | 'rename_db';

export interface DeltaOperation {
  readonly action: DeltaAction;
  readonly name: string;
  readonly new_name?: string;
}

export interface SpecSetting {
  readonly name: string;
  readonly value: string;
  readonly vartype: 'bool' | 'enum' | 'integer' | 'string' | 'real';
}

export interface SpecBuildInput {
  readonly project: ProjectRow;
  readonly branch: BranchRow;
  readonly endpoint: EndpointRow;
  readonly roles: readonly RoleRow[];
  readonly databases: readonly DatabaseRow[];
  readonly storage: { readonly pageserverConnstring: string; readonly safekeeperConnstrings: readonly string[] };
  readonly signer: ComputeSigner;
  readonly deltaOperations?: readonly DeltaOperation[];
  /** Overrides for determinism in tests. */
  readonly operationUuid?: string;
  readonly timestamp?: string;
}

export interface ComputeSpecEnvelope {
  readonly spec: Record<string, unknown>;
  readonly compute_ctl_config: { jwks: { keys: unknown[] } };
}

/** The superuser compute_ctl itself connects with (`-C postgresql://cloud_admin@…`). */
export const CLOUD_ADMIN = 'cloud_admin';
export const COMPUTE_PG_PORT = 55433;

/**
 * Baseline Postgres settings, taken verbatim from the official
 * docker-compose/compute_wrapper/var/db/postgres/configs/config.json.
 */
const BASE_SETTINGS: readonly SpecSetting[] = Object.freeze([
  { name: 'fsync', value: 'off', vartype: 'bool' },
  { name: 'wal_level', value: 'logical', vartype: 'enum' },
  { name: 'wal_log_hints', value: 'on', vartype: 'bool' },
  { name: 'log_connections', value: 'on', vartype: 'bool' },
  { name: 'port', value: String(COMPUTE_PG_PORT), vartype: 'integer' },
  { name: 'shared_buffers', value: '1MB', vartype: 'string' },
  { name: 'max_connections', value: '100', vartype: 'integer' },
  { name: 'listen_addresses', value: '0.0.0.0', vartype: 'string' },
  { name: 'max_wal_senders', value: '10', vartype: 'integer' },
  { name: 'max_replication_slots', value: '10', vartype: 'integer' },
  { name: 'wal_sender_timeout', value: '5s', vartype: 'string' },
  { name: 'password_encryption', value: 'scram-sha-256', vartype: 'enum' },
  { name: 'restart_after_crash', value: 'off', vartype: 'bool' },
  { name: 'synchronous_standby_names', value: 'walproposer', vartype: 'string' },
  { name: 'shared_preload_libraries', value: 'neon', vartype: 'string' },
  { name: 'max_replication_write_lag', value: '500MB', vartype: 'string' },
  { name: 'max_replication_flush_lag', value: '10GB', vartype: 'string' },
]);

export class SpecBuildError extends Error {}

function settingsFor(input: SpecBuildInput): SpecSetting[] {
  const settings = new Map<string, SpecSetting>();
  for (const setting of BASE_SETTINGS) settings.set(setting.name, setting);

  // Storage wiring as GUCs, mirroring the official compose template.
  settings.set('neon.tenant_id', { name: 'neon.tenant_id', value: input.project.tenant_id, vartype: 'string' });
  settings.set('neon.timeline_id', { name: 'neon.timeline_id', value: input.branch.timeline_id, vartype: 'string' });
  settings.set('neon.pageserver_connstring', { name: 'neon.pageserver_connstring', value: input.storage.pageserverConnstring, vartype: 'string' });
  settings.set('neon.safekeepers', { name: 'neon.safekeepers', value: input.storage.safekeeperConnstrings.join(','), vartype: 'string' });

  // Project- then endpoint-level `pg_settings` overrides win over the baseline.
  for (const source of [input.project.settings_json, input.endpoint.settings_json]) {
    const parsed = JSON.parse(source) as { pg_settings?: Record<string, string> };
    for (const [name, value] of Object.entries(parsed.pg_settings ?? {})) {
      settings.set(name, { name, value: String(value), vartype: 'string' });
    }
  }
  return [...settings.values()];
}

export function buildComputeSpec(input: SpecBuildInput): ComputeSpecEnvelope {
  const roleNames = new Set(input.roles.map((role) => role.name));
  for (const database of input.databases) {
    if (!roleNames.has(database.owner_name) && database.owner_name !== CLOUD_ADMIN) {
      // A database whose owner is missing makes compute_ctl fail on start; catch it here instead.
      throw new SpecBuildError(`database ${database.name} is owned by unknown role ${database.owner_name}`);
    }
  }

  const roles = [
    { name: CLOUD_ADMIN, encrypted_password: null, options: null },
    ...input.roles
      .filter((role) => role.name !== CLOUD_ADMIN)
      .map((role) => ({
        name: role.name,
        encrypted_password: role.scram_secret,
        options: role.no_login ? [{ name: 'NOLOGIN', value: '', vartype: 'bool' }] : null,
      })),
  ];

  const spec: Record<string, unknown> = {
    format_version: 1,
    timestamp: input.timestamp ?? new Date().toISOString(),
    operation_uuid: input.operationUuid ?? randomUUID(),
    // -1 means "never suspend"; the control plane suspends from the outside, so the compute's own
    // timer stays off and `suspend_timeout_seconds` on the endpoint row drives the reconciler.
    suspend_timeout_seconds: -1,
    mode: input.endpoint.type === 'read_write' ? 'Primary' : 'Replica',
    skip_pg_catalog_updates: false,
    // Canonical top-level storage wiring.
    tenant_id: input.project.tenant_id,
    timeline_id: input.branch.timeline_id,
    pageserver_connstring: input.storage.pageserverConnstring,
    safekeeper_connstrings: [...input.storage.safekeeperConnstrings],
    project_id: input.project.id,
    endpoint_id: input.endpoint.id,
    branch_id: input.branch.id,
    cluster: {
      cluster_id: input.endpoint.id,
      name: input.project.name,
      state: 'restarted',
      roles,
      databases: input.databases.map((database) => ({
        name: database.name,
        owner: database.owner_name,
        options: null,
      })),
      settings: settingsFor(input),
    },
    delta_operations: [...(input.deltaOperations ?? [])],
  };

  return { spec, compute_ctl_config: { jwks: input.signer.jwks() } };
}

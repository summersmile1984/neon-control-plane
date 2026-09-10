import type { BranchRow, DatabaseRow, EndpointRow, OperationRow, ProjectRow, RoleRow } from '../store/rows.ts';

/**
 * Row -> v2 response object (002 §2 `domain/views.ts`).
 *
 * The spec marks the consumption counters as required on Project, Branch and the list item, so they
 * are emitted as 0 rather than omitted (002 T-305): a self-hosted deployment does no metering, but
 * the shape has to match or every response fails schema validation at the exit.
 */

export interface ViewContext {
  /** Hostname suffix used to build `proxy_host` / endpoint hosts, e.g. `db.siteops.localhost`. */
  readonly zone: string;
  readonly creationSource: string;
  readonly ownerId: string;
}

const bool = (value: number): boolean => value !== 0;

export function projectView(row: ProjectRow, context: ViewContext): Record<string, unknown> {
  return {
    id: row.id,
    platform_id: row.platform_id,
    region_id: row.region_id,
    name: row.name,
    provisioner: row.provisioner,
    pg_version: row.pg_version,
    proxy_host: context.zone,
    branch_logical_size_limit: 0,
    branch_logical_size_limit_bytes: 0,
    store_passwords: bool(row.store_passwords),
    creation_source: context.creationSource,
    history_retention_seconds: row.history_retention_seconds,
    created_at: row.created_at,
    updated_at: row.updated_at,
    owner_id: context.ownerId,
    default_endpoint_settings: {},
    settings: JSON.parse(row.settings_json) as Record<string, unknown>,
    // consumption counters: required by the spec, always zero here
    data_storage_bytes_hour: 0,
    data_transfer_bytes: 0,
    written_data_bytes: 0,
    compute_time_seconds: 0,
    active_time_seconds: 0,
    cpu_used_sec: 0,
    consumption_period_start: row.created_at,
    consumption_period_end: row.created_at,
    synthetic_storage_size: 0,
  };
}

export function projectListItemView(row: ProjectRow, context: ViewContext): Record<string, unknown> {
  const project = projectView(row, context);
  const { data_storage_bytes_hour, data_transfer_bytes, written_data_bytes, compute_time_seconds,
    active_time_seconds, consumption_period_start, consumption_period_end, ...rest } = project;
  void data_storage_bytes_hour; void data_transfer_bytes; void written_data_bytes;
  void compute_time_seconds; void active_time_seconds; void consumption_period_start; void consumption_period_end;
  return { ...rest, active_time: 0 };
}

export function branchView(row: BranchRow, context: ViewContext): Record<string, unknown> {
  const annotation = JSON.parse(row.annotation_json) as Record<string, unknown>;
  return {
    id: row.id,
    project_id: row.project_id,
    ...(row.parent_id ? { parent_id: row.parent_id } : {}),
    ...(row.parent_lsn ? { parent_lsn: row.parent_lsn } : {}),
    ...(row.parent_timestamp ? { parent_timestamp: row.parent_timestamp } : {}),
    name: row.name,
    current_state: row.current_state,
    ...(row.pending_state ? { pending_state: row.pending_state } : {}),
    state_changed_at: row.state_changed_at,
    ...(row.logical_size === null ? {} : { logical_size: row.logical_size }),
    creation_source: context.creationSource,
    primary: bool(row.is_default),
    default: bool(row.is_default),
    protected: bool(row.protected),
    created_at: row.created_at,
    updated_at: row.updated_at,
    cpu_used_sec: 0,
    compute_time_seconds: 0,
    active_time_seconds: 0,
    written_data_bytes: 0,
    data_transfer_bytes: 0,
    // SiteOps reads annotation_value off the branch to reconcile its own logical resources.
    ...(Object.keys(annotation).length > 0 ? { annotation_value: annotation } : {}),
  };
}

export function endpointView(row: EndpointRow, context: ViewContext): Record<string, unknown> {
  return {
    id: row.id,
    project_id: row.project_id,
    branch_id: row.branch_id,
    host: row.host,
    proxy_host: context.zone,
    region_id: 'local',
    type: row.type,
    current_state: row.current_state,
    ...(row.pending_state ? { pending_state: row.pending_state } : {}),
    settings: JSON.parse(row.settings_json) as Record<string, unknown>,
    autoscaling_limit_min_cu: row.autoscaling_min_cu,
    autoscaling_limit_max_cu: row.autoscaling_max_cu,
    pooler_enabled: false,
    pooler_mode: 'transaction',
    disabled: bool(row.disabled),
    passwordless_access: false,
    ...(row.last_active ? { last_active: row.last_active } : {}),
    ...(row.started_at ? { started_at: row.started_at } : {}),
    ...(row.suspended_at ? { suspended_at: row.suspended_at } : {}),
    creation_source: context.creationSource,
    created_at: row.created_at,
    updated_at: row.updated_at,
    suspend_timeout_seconds: row.suspend_timeout_seconds,
    provisioner: 'k8s-pod',
  };
}

export function roleView(row: RoleRow, password?: string): Record<string, unknown> {
  return {
    branch_id: row.branch_id,
    name: row.name,
    protected: bool(row.protected),
    authentication_method: 'password',
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...(password === undefined ? {} : { password }),
  };
}

export function databaseView(row: DatabaseRow): Record<string, unknown> {
  return {
    id: row.id,
    branch_id: row.branch_id,
    name: row.name,
    owner_name: row.owner_name,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function operationView(row: OperationRow): Record<string, unknown> {
  return {
    id: row.id,
    project_id: row.project_id,
    ...(row.branch_id ? { branch_id: row.branch_id } : {}),
    ...(row.endpoint_id ? { endpoint_id: row.endpoint_id } : {}),
    action: row.action,
    status: row.status,
    ...(row.error ? { error: row.error } : {}),
    failures_count: row.failures_count,
    ...(row.retry_at ? { retry_at: row.retry_at } : {}),
    created_at: row.created_at,
    updated_at: row.updated_at,
    total_duration_ms: row.total_duration_ms,
  };
}

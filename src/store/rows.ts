/** Row shapes as SQLite returns them (002 §3). Booleans are 0/1 integers. */

export interface ProjectRow {
  id: string;
  tenant_id: string;
  name: string;
  pg_version: number;
  region_id: string;
  platform_id: string;
  provisioner: string;
  store_passwords: number;
  history_retention_seconds: number;
  default_branch_id: string | null;
  settings_json: string;
  annotation_json: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export type BranchState = 'init' | 'ready' | 'archived';

export interface BranchRow {
  id: string;
  project_id: string;
  timeline_id: string;
  name: string;
  parent_id: string | null;
  parent_lsn: string | null;
  parent_timestamp: string | null;
  is_default: number;
  protected: number;
  current_state: BranchState;
  pending_state: BranchState | null;
  state_changed_at: string;
  logical_size: number | null;
  annotation_json: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export type EndpointType = 'read_write' | 'read_only';
export type EndpointState = 'init' | 'active' | 'idle';

export interface EndpointRow {
  id: string;
  project_id: string;
  branch_id: string;
  type: EndpointType;
  current_state: EndpointState;
  pending_state: EndpointState | null;
  host: string;
  container_id: string | null;
  pg_port: number;
  http_port: number;
  suspend_timeout_seconds: number;
  autoscaling_min_cu: number;
  autoscaling_max_cu: number;
  settings_json: string;
  disabled: number;
  last_active: string | null;
  started_at: string | null;
  suspended_at: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface RoleRow {
  branch_id: string;
  name: string;
  password_ciphertext: string | null;
  scram_secret: string | null;
  protected: number;
  no_login: number;
  created_at: string;
  updated_at: string;
}

export interface DatabaseRow {
  id: number;
  branch_id: string;
  name: string;
  owner_name: string;
  created_at: string;
  updated_at: string;
}

/** Subset of the spec's OperationAction enum that this control plane emits. */
export type OperationAction =
  | 'create_timeline'
  | 'delete_timeline'
  | 'create_branch'
  | 'start_compute'
  | 'suspend_compute'
  | 'apply_config'
  | 'create_compute'
  | 'tenant_detach'
  | 'check_availability';

export type OperationStatus =
  | 'scheduling' | 'running' | 'finished' | 'failed' | 'error' | 'cancelling' | 'cancelled' | 'skipped';

export interface OperationRow {
  id: string;
  project_id: string;
  branch_id: string | null;
  endpoint_id: string | null;
  action: OperationAction;
  status: OperationStatus;
  payload_json: string;
  cursor_step: number;
  error: string | null;
  failures_count: number;
  retry_at: string | null;
  started_at: string | null;
  total_duration_ms: number;
  created_at: string;
  updated_at: string;
}

export interface ApiKeyRow {
  id: string;
  name: string;
  key_hash: string;
  created_at: string;
  last_used_at: string | null;
}

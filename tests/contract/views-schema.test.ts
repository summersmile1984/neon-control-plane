import { describe, expect, it } from 'vitest';
import { createValidators } from '../../src/http/validate.ts';
import { branchView, databaseView, endpointView, operationView, projectListItemView, projectView, roleView, type ViewContext } from '../../src/domain/views.ts';
import type { BranchRow, DatabaseRow, EndpointRow, OperationRow, ProjectRow, RoleRow } from '../../src/store/rows.ts';

/**
 * Every view must satisfy the official schema (002 §12.2 item 1). These are the assertions that
 * catch a missing required field before it reaches a consumer.
 */
const spec = createValidators();
const context: ViewContext = { zone: 'db.neon.localhost', creationSource: 'neon-control-plane', ownerId: 'org-local' };
const ts = '2026-09-07T10:00:00.000Z';

const projectRow: ProjectRow = {
  id: 'quiet-river-123456', tenant_id: 'a'.repeat(32), name: 'demo', pg_version: 17, region_id: 'local',
  platform_id: 'local', provisioner: 'k8s-pod', store_passwords: 1, history_retention_seconds: 604800,
  default_branch_id: 'br-main-0001', settings_json: '{}', annotation_json: '{}',
  created_at: ts, updated_at: ts, deleted_at: null,
};

const branchRow: BranchRow = {
  id: 'br-main-0001', project_id: projectRow.id, timeline_id: 'b'.repeat(32), name: 'main', parent_id: null,
  parent_lsn: null, parent_timestamp: null, is_default: 1, protected: 0, current_state: 'ready',
  pending_state: null, state_changed_at: ts, logical_size: 23027712,
  annotation_json: '{"logical_resource_id":"lr_1","workspace_id":"ws_1"}',
  created_at: ts, updated_at: ts, deleted_at: null,
};

const endpointRow: EndpointRow = {
  id: 'ep-quiet-river-a1b2c3d4', project_id: projectRow.id, branch_id: branchRow.id, name: 'analytics', type: 'read_write',
  current_state: 'active', pending_state: null, host: 'ep-quiet-river-a1b2c3d4.db.neon.localhost',
  container_id: 'abc', pg_port: 55501, http_port: 55601, suspend_timeout_seconds: 300,
  autoscaling_min_cu: 0.25, autoscaling_max_cu: 0.25, settings_json: '{}', disabled: 0,
  last_active: ts, started_at: ts, suspended_at: null, created_at: ts, updated_at: ts, deleted_at: null,
};

const roleRow: RoleRow = {
  branch_id: branchRow.id, name: 'neondb_owner', password_ciphertext: 'sealed', scram_secret: 'SCRAM-SHA-256$4096:x$y:z',
  protected: 0, no_login: 0, created_at: ts, updated_at: ts,
};

const databaseRow: DatabaseRow = { id: 1, branch_id: branchRow.id, name: 'neondb', owner_name: 'neondb_owner', created_at: ts, updated_at: ts };

const operationRow: OperationRow = {
  id: '3f6a1b2c-1111-4222-8333-444455556666', project_id: projectRow.id, branch_id: branchRow.id,
  endpoint_id: endpointRow.id, action: 'start_compute', status: 'finished', payload_json: '{}', cursor_step: 5,
  error: null, failures_count: 0, retry_at: null, started_at: ts, total_duration_ms: 4200, created_at: ts, updated_at: ts,
};

function expectValid(schemaName: string, body: unknown): void {
  const validate = spec.get(schemaName);
  const valid = validate(body);
  expect(valid, `${schemaName}: ${spec.errorText(schemaName)}`).toBe(true);
}

describe('views satisfy the official schemas', () => {
  it('returns actual project ownership and reconciliation markers without substituting the configured default organization', () => {
    const annotation = { workspace_id: 'ws_actual', logical_resource_id: 'ws_actual' };
    const row = { ...projectRow, org_id: 'org-other', annotation_json: JSON.stringify(annotation) };
    const view = projectView(row, context);
    expect(view).toMatchObject({ org_id: 'org-other', owner_id: 'org-other', default_branch_id: row.default_branch_id, annotation_value: annotation });
    expectValid('Project', view); expectValid('ProjectListItem', projectListItemView(row, context));
  });
  it('Project', () => expectValid('Project', projectView(projectRow, context)));
  it('ProjectListItem', () => expectValid('ProjectListItem', projectListItemView(projectRow, context)));
  it('Branch', () => expectValid('Branch', branchView(branchRow, context)));
  it('Endpoint', () => expectValid('Endpoint', endpointView(endpointRow, context)));
  it('Role', () => expectValid('Role', roleView(roleRow)));
  it('Role with password', () => expectValid('Role', roleView(roleRow, 'plaintext')));
  it('Database', () => expectValid('Database', databaseView(databaseRow)));
  it('Operation', () => expectValid('Operation', operationView(operationRow)));

  it('wrapped responses', () => {
    expectValid('ProjectResponse', { project: projectView(projectRow, context) });
    expectValid('BranchResponse', { branch: branchView(branchRow, context) });
    expectValid('EndpointsResponse', { endpoints: [endpointView(endpointRow, context)] });
    expectValid('RolesResponse', { roles: [roleView(roleRow)] });
    expectValid('DatabasesResponse', { databases: [databaseView(databaseRow)] });
    expectValid('OperationsResponse', { operations: [operationView(operationRow)] });
    expectValid('ConnectionURIResponse', { uri: 'postgresql://u:p@h:5432/d?sslmode=require' });
  });

  it('composed operation responses', () => {
    expectValid('BranchOperations', { branch: branchView(branchRow, context), operations: [operationView(operationRow)] });
    expectValid('EndpointOperations', { endpoint: endpointView(endpointRow, context), operations: [operationView(operationRow)] });
    expectValid('RoleOperations', { role: roleView(roleRow, 'plaintext'), operations: [operationView(operationRow)] });
    expectValid('DatabaseOperations', { database: databaseView(databaseRow), operations: [operationView(operationRow)] });
  });

  it('the composed create responses used by POST /projects and POST /branches', () => {
    expectValid('responses:CreatedProject', {
      project: projectView(projectRow, context),
      connection_uris: [{
        connection_uri: 'postgresql://neondb_owner:pw@ep.db.neon.localhost:5432/neondb?sslmode=require',
        connection_parameters: {
          database: 'neondb', password: 'pw', role: 'neondb_owner',
          host: 'ep-quiet-river-a1b2c3d4.db.neon.localhost',
          pooler_host: 'ep-quiet-river-a1b2c3d4-pooler.db.neon.localhost',
        },
      }],
      roles: [roleView(roleRow, 'pw')],
      databases: [databaseView(databaseRow)],
      operations: [operationView(operationRow)],
      branch: branchView(branchRow, context),
      endpoints: [endpointView(endpointRow, context)],
    });
    expectValid('responses:CreatedBranch', {
      branch: branchView(branchRow, context),
      endpoints: [endpointView(endpointRow, context)],
      operations: [operationView(operationRow)],
      roles: [roleView(roleRow)],
      databases: [databaseView(databaseRow)],
    });
  });

  it('rejects a body that drops a required field', () => {
    const broken = { ...projectView(projectRow, context) } as Record<string, unknown>;
    delete broken.pg_version;
    expect(spec.get('Project')(broken)).toBe(false);
  });

  it('rejects an out-of-range enum value', () => {
    const broken = { ...endpointView(endpointRow, context), current_state: 'sleeping' };
    expect(spec.get('Endpoint')(broken)).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { buildComputeSpec, CLOUD_ADMIN, SpecBuildError, type SpecBuildInput } from '../../src/domain/spec-builder.ts';
import { loadComputeSigner } from '../../src/domain/compute-auth.ts';
import { generateKeyPairSync } from 'node:crypto';
import type { BranchRow, DatabaseRow, EndpointRow, ProjectRow, RoleRow } from '../../src/store/rows.ts';

/**
 * Golden test for the most version-sensitive artefact in the system (002 §8). When a Neon upgrade
 * changes what compute_ctl expects, this is the assertion that should fail first.
 */

const { privateKey } = generateKeyPairSync('ed25519');
const signer = loadComputeSigner(privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), 'golden-key');
const ts = '2026-09-07T10:00:00.000Z';

const project: ProjectRow = {
  id: 'quiet-river-123456', tenant_id: 'a'.repeat(32), name: 'demo', pg_version: 17, region_id: 'local',
  platform_id: 'local', provisioner: 'k8s-pod', store_passwords: 1, history_retention_seconds: 604800,
  default_branch_id: 'br-main-0001', settings_json: '{}', annotation_json: '{}', created_at: ts, updated_at: ts, deleted_at: null,
};

const branch: BranchRow = {
  id: 'br-main-0001', project_id: project.id, timeline_id: 'b'.repeat(32), name: 'main', parent_id: null,
  parent_lsn: null, parent_timestamp: null, is_default: 1, protected: 0, current_state: 'ready',
  pending_state: null, state_changed_at: ts, logical_size: null, annotation_json: '{}',
  created_at: ts, updated_at: ts, deleted_at: null,
};

const endpoint: EndpointRow = {
  id: 'ep-quiet-river-a1b2c3d4', project_id: project.id, branch_id: branch.id, type: 'read_write',
  current_state: 'init', pending_state: null, host: 'ep-quiet-river-a1b2c3d4.db.siteops.localhost',
  container_id: null, pg_port: 55501, http_port: 55601, suspend_timeout_seconds: 300,
  autoscaling_min_cu: 0.25, autoscaling_max_cu: 0.25, settings_json: '{}', disabled: 0,
  last_active: null, started_at: null, suspended_at: null, created_at: ts, updated_at: ts, deleted_at: null,
};

const owner: RoleRow = {
  branch_id: branch.id, name: 'neondb_owner', password_ciphertext: 'sealed',
  scram_secret: 'SCRAM-SHA-256$4096:c2FsdA==$c3RvcmVk:c2VydmVy', protected: 0, no_login: 0, created_at: ts, updated_at: ts,
};

const database: DatabaseRow = { id: 1, branch_id: branch.id, name: 'neondb', owner_name: 'neondb_owner', created_at: ts, updated_at: ts };

const input: SpecBuildInput = {
  project, branch, endpoint, roles: [owner], databases: [database],
  storage: { pageserverConnstring: 'host=pageserver port=6400', safekeeperConnstrings: ['safekeeper1:5454'] },
  signer, operationUuid: '00000000-0000-4000-8000-000000000000', timestamp: ts,
};

describe('compute spec', () => {
  it('matches the golden envelope', () => {
    const envelope = buildComputeSpec(input);
    const spec = envelope.spec as Record<string, unknown>;
    const cluster = spec.cluster as Record<string, unknown>;

    expect(spec.format_version).toBe(1);
    expect(spec.timestamp).toBe(ts);
    expect(spec.operation_uuid).toBe('00000000-0000-4000-8000-000000000000');
    expect(spec.mode).toBe('Primary');
    expect(spec.suspend_timeout_seconds).toBe(-1);
    expect(spec.skip_pg_catalog_updates).toBe(false);
    expect(spec.tenant_id).toBe(project.tenant_id);
    expect(spec.timeline_id).toBe(branch.timeline_id);
    expect(spec.pageserver_connstring).toBe('host=pageserver port=6400');
    expect(spec.safekeeper_connstrings).toEqual(['safekeeper1:5454']);
    expect(spec.project_id).toBe(project.id);
    expect(spec.endpoint_id).toBe(endpoint.id);
    expect(cluster.cluster_id).toBe(endpoint.id);
    expect(cluster.state).toBe('restarted');
    expect(spec.delta_operations).toEqual([]);

    // compute_ctl refuses a config without jwks; the public half of the signing key belongs here.
    expect((envelope.compute_ctl_config.jwks.keys[0] as Record<string, unknown>).kid).toBe('golden-key');
    expect((envelope.compute_ctl_config.jwks.keys[0] as Record<string, unknown>).alg).toBe('EdDSA');
  });

  it('always includes cloud_admin and passes SCRAM verifiers as encrypted_password', () => {
    const cluster = buildComputeSpec(input).spec.cluster as { roles: Array<Record<string, unknown>> };
    expect(cluster.roles[0]!.name).toBe(CLOUD_ADMIN);
    const app = cluster.roles.find((role) => role.name === 'neondb_owner')!;
    expect(app.encrypted_password).toBe(owner.scram_secret);
    expect(app.options).toBeNull();
  });

  it('marks a no_login role NOLOGIN', () => {
    const cluster = buildComputeSpec({ ...input, roles: [{ ...owner, no_login: 1 }] }).spec.cluster as { roles: Array<Record<string, unknown>> };
    expect(cluster.roles.find((role) => role.name === 'neondb_owner')!.options).toEqual([{ name: 'NOLOGIN', value: '', vartype: 'bool' }]);
  });

  it('writes both the top-level storage fields and the neon.* GUCs', () => {
    const cluster = buildComputeSpec(input).spec.cluster as { settings: Array<{ name: string; value: string }> };
    const byName = new Map(cluster.settings.map((setting) => [setting.name, setting.value]));
    expect(byName.get('neon.tenant_id')).toBe(project.tenant_id);
    expect(byName.get('neon.timeline_id')).toBe(branch.timeline_id);
    expect(byName.get('neon.pageserver_connstring')).toBe('host=pageserver port=6400');
    expect(byName.get('neon.safekeepers')).toBe('safekeeper1:5454');
    expect(byName.get('port')).toBe('55433');
    expect(byName.get('shared_preload_libraries')).toBe('neon');
    expect(byName.get('password_encryption')).toBe('scram-sha-256');
  });

  it('lets endpoint pg_settings override the baseline', () => {
    const envelope = buildComputeSpec({
      ...input,
      endpoint: { ...endpoint, settings_json: JSON.stringify({ pg_settings: { shared_buffers: '64MB' } }) },
    });
    const cluster = envelope.spec.cluster as { settings: Array<{ name: string; value: string }> };
    expect(cluster.settings.find((setting) => setting.name === 'shared_buffers')?.value).toBe('64MB');
  });

  it('uses Replica mode for a read_only endpoint', () => {
    const envelope = buildComputeSpec({ ...input, endpoint: { ...endpoint, type: 'read_only' } });
    expect(envelope.spec.mode).toBe('Replica');
  });

  it('carries delta operations through', () => {
    const envelope = buildComputeSpec({ ...input, deltaOperations: [{ action: 'delete_role', name: 'gone' }] });
    expect(envelope.spec.delta_operations).toEqual([{ action: 'delete_role', name: 'gone' }]);
  });

  it('refuses a database whose owner is not in the spec', () => {
    expect(() => buildComputeSpec({ ...input, roles: [], databases: [database] })).toThrow(SpecBuildError);
  });

  it('is deterministic for the same input', () => {
    expect(JSON.stringify(buildComputeSpec(input))).toBe(JSON.stringify(buildComputeSpec(input)));
  });
});

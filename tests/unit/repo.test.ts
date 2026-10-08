import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/store/db.ts';
import { createRepositories, type Repositories } from '../../src/store/repo.ts';
import { generateBranchId, generateEndpointId, generateHexId, generateOperationId, generateProjectId } from '../../src/domain/ids.ts';

let repos: Repositories;
let projectId: string;
let branchId: string;

function seed(): void {
  projectId = generateProjectId();
  repos.projects.insert({
    id: projectId, tenant_id: generateHexId(), name: 'test', pg_version: 17, region_id: 'local',
    platform_id: 'local', provisioner: 'k8s-pod', store_passwords: 1, history_retention_seconds: 604800,
    default_branch_id: null, settings_json: '{}', annotation_json: '{}',
  });
  branchId = generateBranchId();
  repos.branches.insert({
    id: branchId, project_id: projectId, timeline_id: generateHexId(), name: 'main', parent_id: null,
    parent_lsn: null, parent_timestamp: null, is_default: 1, protected: 0, current_state: 'ready',
    pending_state: null, logical_size: null, annotation_json: '{}',
  });
  repos.projects.update(projectId, { default_branch_id: branchId });
}

beforeEach(() => {
  repos = createRepositories(openDatabase(':memory:'));
  seed();
});

describe('migrations', () => {
  it('creates every table the design calls for', () => {
    const tables = repos.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((row) => (row as { name: string }).name);
    for (const table of ['projects', 'branches', 'endpoints', 'roles', 'databases', 'operations', 'api_keys', 'settings', 'users', 'organizations', 'members', 'sessions']) {
      expect(tables, table).toContain(table);
    }
  });

  it('is idempotent', () => {
    const db = openDatabase(':memory:');
    const first = createRepositories(db);
    expect(first.projects.list(10, undefined)).toEqual([]);
  });
});

describe('projects', () => {
  it('round-trips and hides soft-deleted rows', () => {
    const project = repos.projects.get(projectId);
    expect(project?.name).toBe('test');
    expect(project?.default_branch_id).toBe(branchId);

    repos.projects.softDelete(projectId);
    expect(repos.projects.get(projectId)).toBeUndefined();
    expect(repos.projects.list(10)).toEqual([]);
  });

  it('rejects a duplicate tenant id', () => {
    const tenant = repos.projects.get(projectId)!.tenant_id;
    expect(() => repos.projects.insert({
      id: generateProjectId(), tenant_id: tenant, name: 'dup', pg_version: 17, region_id: 'local',
      platform_id: 'local', provisioner: 'k8s-pod', store_passwords: 1, history_retention_seconds: 604800,
      default_branch_id: null, settings_json: '{}', annotation_json: '{}',
    })).toThrow(/UNIQUE/);
  });

  it('pages with a cursor', () => {
    for (let index = 0; index < 3; index += 1) {
      repos.projects.insert({
        id: `zz-page-${index}`, tenant_id: generateHexId(), name: `p${index}`, pg_version: 17, region_id: 'local',
        platform_id: 'local', provisioner: 'k8s-pod', store_passwords: 1, history_retention_seconds: 604800,
        default_branch_id: null, settings_json: '{}', annotation_json: '{}',
      });
    }
    const first = repos.projects.list(2);
    expect(first).toHaveLength(2);
    const second = repos.projects.list(10, first[1]!.id);
    expect(second.map((row) => row.id)).not.toContain(first[0]!.id);
  });
});

describe('branches', () => {
  it('enforces one name per project', () => {
    expect(() => repos.branches.insert({
      id: generateBranchId(), project_id: projectId, timeline_id: generateHexId(), name: 'main', parent_id: null,
      parent_lsn: null, parent_timestamp: null, is_default: 0, protected: 0, current_state: 'init',
      pending_state: null, logical_size: null, annotation_json: '{}',
    })).toThrow(/UNIQUE/);
  });

  it('tracks parents and state transitions', () => {
    const childId = generateBranchId();
    repos.branches.insert({
      id: childId, project_id: projectId, timeline_id: generateHexId(), name: 'child', parent_id: branchId,
      parent_lsn: '0/14E8F98', parent_timestamp: null, is_default: 0, protected: 0, current_state: 'init',
      pending_state: null, logical_size: null, annotation_json: '{}',
    });
    expect(repos.branches.listChildren(branchId).map((row) => row.id)).toEqual([childId]);

    const before = repos.branches.get(childId)!;
    const after = repos.branches.setState(childId, 'ready');
    expect(after?.current_state).toBe('ready');
    expect(Date.parse(after!.state_changed_at)).toBeGreaterThanOrEqual(Date.parse(before.state_changed_at));
  });

  it('moves the default flag', () => {
    const otherId = generateBranchId();
    repos.branches.insert({
      id: otherId, project_id: projectId, timeline_id: generateHexId(), name: 'other', parent_id: branchId,
      parent_lsn: null, parent_timestamp: null, is_default: 0, protected: 0, current_state: 'ready',
      pending_state: null, logical_size: null, annotation_json: '{}',
    });
    repos.branches.clearDefault(projectId);
    repos.branches.update(otherId, { is_default: 1 });
    expect(repos.branches.get(branchId)?.is_default).toBe(0);
    expect(repos.branches.get(otherId)?.is_default).toBe(1);
  });
});

describe('endpoints', () => {
  const makeEndpoint = (type: 'read_write' | 'read_only') => repos.endpoints.insert({
    id: generateEndpointId(), project_id: projectId, branch_id: branchId, name: null, type, current_state: 'init',
    host: '127.0.0.1', pg_port: 55501 + (type === 'read_only' ? 1 : 0), http_port: 55601,
    suspend_timeout_seconds: 300, autoscaling_min_cu: 0.25, autoscaling_max_cu: 0.25, settings_json: '{}', disabled: 0,
  });

  it('allows only one read_write endpoint per branch', () => {
    makeEndpoint('read_write');
    expect(() => makeEndpoint('read_write')).toThrow(/UNIQUE/);
    expect(() => makeEndpoint('read_only')).not.toThrow();
  });

  it('frees the read_write slot after a soft delete', () => {
    const first = makeEndpoint('read_write');
    repos.endpoints.softDelete(first.id);
    expect(() => makeEndpoint('read_write')).not.toThrow();
  });

  it('stamps started_at and suspended_at on state changes', () => {
    const endpoint = makeEndpoint('read_write');
    expect(repos.endpoints.setState(endpoint.id, 'active')?.started_at).toBeTruthy();
    expect(repos.endpoints.setState(endpoint.id, 'idle')?.suspended_at).toBeTruthy();
    expect(repos.endpoints.listActive()).toHaveLength(0);
  });

  it('reports the ports already in use', () => {
    const endpoint = makeEndpoint('read_write');
    expect(repos.endpoints.usedPorts().sort()).toEqual([endpoint.pg_port, endpoint.http_port].sort());
  });
});

describe('roles and databases', () => {
  it('upserts a role and rotates its password', () => {
    repos.roles.upsert({ branch_id: branchId, name: 'owner', password_ciphertext: 'c1', scram_secret: 's1', protected: 0, no_login: 0 });
    expect(repos.roles.get(branchId, 'owner')?.scram_secret).toBe('s1');

    repos.roles.setPassword(branchId, 'owner', 'c2', 's2');
    expect(repos.roles.get(branchId, 'owner')?.scram_secret).toBe('s2');

    repos.roles.upsert({ branch_id: branchId, name: 'owner', password_ciphertext: 'c3', scram_secret: 's3', protected: 0, no_login: 1 });
    expect(repos.roles.listByBranch(branchId)).toHaveLength(1);
    expect(repos.roles.get(branchId, 'owner')?.no_login).toBe(1);
  });

  it('links databases to their owner and rejects duplicates', () => {
    repos.roles.upsert({ branch_id: branchId, name: 'owner', password_ciphertext: null, scram_secret: null, protected: 0, no_login: 0 });
    const database = repos.databases.insert({ branch_id: branchId, name: 'neondb', owner_name: 'owner' });
    expect(database.id).toBeGreaterThan(0);
    expect(repos.databases.ownedBy(branchId, 'owner').map((row) => row.name)).toEqual(['neondb']);
    expect(() => repos.databases.insert({ branch_id: branchId, name: 'neondb', owner_name: 'owner' })).toThrow(/UNIQUE/);
    expect(repos.databases.remove(branchId, 'neondb')).toBe(true);
    expect(repos.databases.remove(branchId, 'neondb')).toBe(false);
  });

  it('cascades role and database rows when the branch goes away', () => {
    repos.roles.upsert({ branch_id: branchId, name: 'owner', password_ciphertext: null, scram_secret: null, protected: 0, no_login: 0 });
    repos.databases.insert({ branch_id: branchId, name: 'neondb', owner_name: 'owner' });
    repos.db.prepare('DELETE FROM branches WHERE id = ?').run(branchId);
    expect(repos.roles.listByBranch(branchId)).toEqual([]);
    expect(repos.databases.listByBranch(branchId)).toEqual([]);
  });
});

describe('operations', () => {
  const makeOperation = (overrides: Partial<{ branch_id: string | null; endpoint_id: string | null }> = {}) =>
    repos.operations.insert({ id: generateOperationId(), project_id: projectId, branch_id: branchId, action: 'apply_config', ...overrides });

  it('claims work exactly once', () => {
    const operation = makeOperation();
    const claimed = repos.operations.claimNext(new Date().toISOString());
    expect(claimed?.id).toBe(operation.id);
    expect(claimed?.status).toBe('running');
    expect(repos.operations.claimNext(new Date().toISOString())).toBeUndefined();
  });

  it('does not claim a second operation on the same branch while one runs', () => {
    makeOperation();
    makeOperation();
    expect(repos.operations.claimNext(new Date().toISOString())).toBeDefined();
    expect(repos.operations.claimNext(new Date().toISOString())).toBeUndefined();
  });

  it('honours retry_at', () => {
    const operation = makeOperation();
    const future = new Date(Date.now() + 60_000).toISOString();
    repos.operations.reschedule(operation.id, future, 'transient');
    expect(repos.operations.claimNext(new Date().toISOString())).toBeUndefined();
    expect(repos.operations.claimNext(future)).toBeDefined();
    expect(repos.operations.get(operation.id)?.failures_count).toBe(1);
  });

  it('records terminal states', () => {
    const finished = makeOperation({ branch_id: null });
    repos.operations.finish(finished.id, 120);
    expect(repos.operations.get(finished.id)).toMatchObject({ status: 'finished', total_duration_ms: 120, error: null });

    const failed = makeOperation({ branch_id: null });
    repos.operations.fail(failed.id, 'step ensure_container failed', 300);
    expect(repos.operations.get(failed.id)).toMatchObject({ status: 'failed', error: 'step ensure_container failed' });
  });

  it('tracks step progress for resume after a restart', () => {
    const operation = makeOperation();
    repos.operations.advance(operation.id, 3);
    expect(repos.operations.get(operation.id)?.cursor_step).toBe(3);
  });

  it('reports whether a resource is busy', () => {
    expect(repos.operations.hasActiveFor({ branch_id: branchId })).toBe(false);
    makeOperation();
    expect(repos.operations.hasActiveFor({ branch_id: branchId })).toBe(true);
  });
});

describe('api keys', () => {
  it('finds a key by hash and records use', () => {
    const key = repos.apiKeys.insert({ name: 'local', key_hash: 'abc', created_by: 'u1' });
    expect(repos.apiKeys.findByHash('abc')?.id).toBe(key.id);
    expect(repos.apiKeys.findByHash('nope')).toBeUndefined();
    repos.apiKeys.touch(key.id, '10.0.0.1');
    expect(repos.apiKeys.findByHash('abc')?.last_used_at).toBeTruthy();
    expect(repos.apiKeys.findByHash('abc')?.last_used_from_addr).toBe('10.0.0.1');
    expect(repos.apiKeys.count()).toBe(1);
  });
});

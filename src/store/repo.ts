import type { Db } from './db.ts';
import { now } from './db.ts';
import type {
  ApiKeyKind, ApiKeyRow, BranchRow, BranchState, DatabaseRow, EndpointRow, EndpointState,
  MemberRole, MemberRow, OperationAction, OperationRow, OperationStatus, OrganizationRow, ProjectRow,
  RoleRow, SessionRow, UserRow,
} from './rows.ts';

/**
 * Repositories (002 §3). Deviation from the file layout in 002 §2: all repositories live here
 * rather than in `store/repo/*.ts`; the surface is small enough that seven files would be noise.
 *
 * Every mutation stamps `updated_at`. Soft-deleted rows (`deleted_at`) stay out of every list and
 * lookup so that a delete is idempotent for the reconciler.
 */

export interface Repositories {
  readonly db: Db;
  readonly projects: ProjectRepo;
  readonly branches: BranchRepo;
  readonly endpoints: EndpointRepo;
  readonly roles: RoleRepo;
  readonly databases: DatabaseRepo;
  readonly operations: OperationRepo;
  readonly apiKeys: ApiKeyRepo;
  readonly users: UserRepo;
  readonly organizations: OrganizationRepo;
  readonly members: MemberRepo;
  readonly sessions: SessionRepo;
  transaction<T>(fn: () => T): T;
}

export interface ProjectRepo {
  insert(row: Omit<ProjectRow, 'created_at' | 'updated_at' | 'deleted_at'>): ProjectRow;
  get(id: string): ProjectRow | undefined;
  getByTenant(tenantId: string): ProjectRow | undefined;
  list(limit: number, cursor?: string): ProjectRow[];
  update(id: string, patch: Partial<Pick<ProjectRow, 'name' | 'settings_json' | 'history_retention_seconds' | 'default_branch_id'>>): ProjectRow | undefined;
  softDelete(id: string): void;
}

export interface BranchRepo {
  insert(row: Omit<BranchRow, 'created_at' | 'updated_at' | 'deleted_at' | 'state_changed_at'>): BranchRow;
  get(id: string): BranchRow | undefined;
  getByName(projectId: string, name: string): BranchRow | undefined;
  listByProject(projectId: string): BranchRow[];
  listChildren(parentId: string): BranchRow[];
  update(id: string, patch: Partial<Pick<BranchRow, 'name' | 'protected' | 'is_default' | 'logical_size' | 'annotation_json'>>): BranchRow | undefined;
  setState(id: string, state: BranchState, pending?: BranchState | null): BranchRow | undefined;
  clearDefault(projectId: string): void;
  softDelete(id: string): void;
}

export interface EndpointRepo {
  insert(row: Omit<EndpointRow, 'created_at' | 'updated_at' | 'deleted_at' | 'last_active' | 'started_at' | 'suspended_at' | 'container_id' | 'pending_state'>): EndpointRow;
  get(id: string): EndpointRow | undefined;
  listByProject(projectId: string): EndpointRow[];
  listByBranch(branchId: string): EndpointRow[];
  listActive(): EndpointRow[];
  readWriteFor(branchId: string): EndpointRow | undefined;
  update(id: string, patch: Partial<Pick<EndpointRow, 'suspend_timeout_seconds' | 'autoscaling_min_cu' | 'autoscaling_max_cu' | 'settings_json' | 'disabled' | 'branch_id' | 'container_id' | 'host'>>): EndpointRow | undefined;
  setState(id: string, state: EndpointState, pending?: EndpointState | null): EndpointRow | undefined;
  touchActivity(id: string): void;
  usedPorts(): number[];
  softDelete(id: string): void;
}

export interface RoleRepo {
  upsert(row: Omit<RoleRow, 'created_at' | 'updated_at'>): RoleRow;
  get(branchId: string, name: string): RoleRow | undefined;
  listByBranch(branchId: string): RoleRow[];
  setPassword(branchId: string, name: string, ciphertext: string, scram: string): RoleRow | undefined;
  remove(branchId: string, name: string): boolean;
}

export interface DatabaseRepo {
  insert(row: Omit<DatabaseRow, 'id' | 'created_at' | 'updated_at'>): DatabaseRow;
  get(branchId: string, name: string): DatabaseRow | undefined;
  listByBranch(branchId: string): DatabaseRow[];
  rename(branchId: string, name: string, patch: { name?: string; owner_name?: string }): DatabaseRow | undefined;
  remove(branchId: string, name: string): boolean;
  ownedBy(branchId: string, roleName: string): DatabaseRow[];
}

export interface OperationRepo {
  insert(input: {
    id: string; project_id: string; branch_id?: string | null; endpoint_id?: string | null;
    action: OperationAction; payload?: unknown; status?: OperationStatus;
  }): OperationRow;
  get(id: string): OperationRow | undefined;
  listByProject(projectId: string, limit: number): OperationRow[];
  /** Newest operations across every project. The v2 API has no such route; the console needs one. */
  listRecent(limit: number): OperationRow[];
  listByIds(ids: readonly string[]): OperationRow[];
  /** CAS claim: only one worker can move an operation out of `scheduling`. */
  claimNext(nowIso: string): OperationRow | undefined;
  advance(id: string, cursorStep: number): void;
  finish(id: string, durationMs: number): void;
  fail(id: string, error: string, durationMs: number): void;
  reschedule(id: string, retryAt: string, error: string): void;
  hasActiveFor(scope: { branch_id?: string | null; endpoint_id?: string | null }): boolean;
}

export interface ApiKeyRepo {
  insert(row: {
    name: string; key_hash: string; created_by?: string | null;
    kind?: ApiKeyKind; org_id?: string | null; project_id?: string | null;
  }): ApiKeyRow;
  get(id: number): ApiKeyRow | undefined;
  findByHash(hash: string): ApiKeyRow | undefined;
  listByUser(userId: string): ApiKeyRow[];
  listByOrg(orgId: string): ApiKeyRow[];
  revoke(id: number): ApiKeyRow | undefined;
  touch(id: number, addr?: string): void;
  count(): number;
}

export interface UserRepo {
  insert(row: Omit<UserRow, 'created_at' | 'updated_at'>): UserRow;
  get(id: string): UserRow | undefined;
  getByEmail(email: string): UserRow | undefined;
  list(): UserRow[];
  setPassword(id: string, hash: string): void;
  count(): number;
}

export interface OrganizationRepo {
  insert(row: Omit<OrganizationRow, 'created_at' | 'updated_at'>): OrganizationRow;
  get(id: string): OrganizationRow | undefined;
  list(): OrganizationRow[];
  count(): number;
}

export interface MemberRepo {
  insert(row: Omit<MemberRow, 'joined_at'>): MemberRow;
  get(id: string): MemberRow | undefined;
  getByUserAndOrg(userId: string, orgId: string): MemberRow | undefined;
  listByOrg(orgId: string): MemberRow[];
  listByUser(userId: string): MemberRow[];
  setRole(id: string, role: MemberRole): MemberRow | undefined;
  remove(id: string): boolean;
  count(): number;
}

export interface SessionRepo {
  insert(row: { id: string; user_id: string; expires_at: string }): SessionRow;
  get(id: string): SessionRow | undefined;
  touch(id: string): void;
  remove(id: string): boolean;
  removeExpired(nowIso: string): void;
}

const ACTIVE_STATUSES = "('scheduling','running')";

export function createRepositories(db: Db): Repositories {
  const one = <T>(sql: string, ...params: unknown[]): T | undefined => db.prepare(sql).get(...params) as T | undefined;
  const many = <T>(sql: string, ...params: unknown[]): T[] => db.prepare(sql).all(...params) as T[];
  const run = (sql: string, ...params: unknown[]): number => db.prepare(sql).run(...params).changes;

  const projects: ProjectRepo = {
    insert(row) {
      const ts = now();
      db.prepare(
        `INSERT INTO projects (id, tenant_id, name, pg_version, region_id, platform_id, provisioner, store_passwords,
           history_retention_seconds, default_branch_id, settings_json, annotation_json, org_id, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        row.id, row.tenant_id, row.name, row.pg_version, row.region_id, row.platform_id, row.provisioner,
        row.store_passwords, row.history_retention_seconds, row.default_branch_id, row.settings_json,
        row.annotation_json, row.org_id ?? null, ts, ts,
      );
      return projects.get(row.id) as ProjectRow;
    },
    get: (id) => one<ProjectRow>('SELECT * FROM projects WHERE id = ? AND deleted_at IS NULL', id),
    getByTenant: (tenantId) => one<ProjectRow>('SELECT * FROM projects WHERE tenant_id = ? AND deleted_at IS NULL', tenantId),
    list: (limit, cursor) => (cursor
      ? many<ProjectRow>('SELECT * FROM projects WHERE deleted_at IS NULL AND id > ? ORDER BY id LIMIT ?', cursor, limit)
      : many<ProjectRow>('SELECT * FROM projects WHERE deleted_at IS NULL ORDER BY id LIMIT ?', limit)),
    update(id, patch) {
      const fields = Object.keys(patch);
      if (fields.length > 0) {
        run(
          `UPDATE projects SET ${fields.map((field) => `${field} = ?`).join(', ')}, updated_at = ? WHERE id = ? AND deleted_at IS NULL`,
          ...fields.map((field) => (patch as Record<string, unknown>)[field]), now(), id,
        );
      }
      return projects.get(id);
    },
    softDelete: (id) => { run('UPDATE projects SET deleted_at = ?, updated_at = ? WHERE id = ?', now(), now(), id); },
  };

  const branches: BranchRepo = {
    insert(row) {
      const ts = now();
      db.prepare(
        `INSERT INTO branches (id, project_id, timeline_id, name, parent_id, parent_lsn, parent_timestamp, is_default,
           protected, current_state, pending_state, state_changed_at, logical_size, annotation_json, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        row.id, row.project_id, row.timeline_id, row.name, row.parent_id, row.parent_lsn, row.parent_timestamp,
        row.is_default, row.protected, row.current_state, row.pending_state, ts, row.logical_size, row.annotation_json, ts, ts,
      );
      return branches.get(row.id) as BranchRow;
    },
    get: (id) => one<BranchRow>('SELECT * FROM branches WHERE id = ? AND deleted_at IS NULL', id),
    getByName: (projectId, name) => one<BranchRow>('SELECT * FROM branches WHERE project_id = ? AND name = ? AND deleted_at IS NULL', projectId, name),
    listByProject: (projectId) => many<BranchRow>('SELECT * FROM branches WHERE project_id = ? AND deleted_at IS NULL ORDER BY created_at', projectId),
    listChildren: (parentId) => many<BranchRow>('SELECT * FROM branches WHERE parent_id = ? AND deleted_at IS NULL', parentId),
    update(id, patch) {
      const fields = Object.keys(patch);
      if (fields.length > 0) {
        run(
          `UPDATE branches SET ${fields.map((field) => `${field} = ?`).join(', ')}, updated_at = ? WHERE id = ? AND deleted_at IS NULL`,
          ...fields.map((field) => (patch as Record<string, unknown>)[field]), now(), id,
        );
      }
      return branches.get(id);
    },
    setState(id, state, pending = null) {
      const ts = now();
      run('UPDATE branches SET current_state = ?, pending_state = ?, state_changed_at = ?, updated_at = ? WHERE id = ?', state, pending, ts, ts, id);
      return branches.get(id);
    },
    clearDefault: (projectId) => { run('UPDATE branches SET is_default = 0, updated_at = ? WHERE project_id = ? AND is_default = 1', now(), projectId); },
    softDelete: (id) => { run('UPDATE branches SET deleted_at = ?, updated_at = ? WHERE id = ?', now(), now(), id); },
  };

  const endpoints: EndpointRepo = {
    insert(row) {
      const ts = now();
      db.prepare(
        `INSERT INTO endpoints (id, project_id, branch_id, type, current_state, pending_state, host, container_id,
           pg_port, http_port, suspend_timeout_seconds, autoscaling_min_cu, autoscaling_max_cu, settings_json,
           disabled, created_at, updated_at)
         VALUES (?,?,?,?,?,NULL,?,NULL,?,?,?,?,?,?,?,?,?)`,
      ).run(
        row.id, row.project_id, row.branch_id, row.type, row.current_state, row.host,
        row.pg_port, row.http_port, row.suspend_timeout_seconds, row.autoscaling_min_cu, row.autoscaling_max_cu,
        row.settings_json, row.disabled, ts, ts,
      );
      return endpoints.get(row.id) as EndpointRow;
    },
    get: (id) => one<EndpointRow>('SELECT * FROM endpoints WHERE id = ? AND deleted_at IS NULL', id),
    listByProject: (projectId) => many<EndpointRow>('SELECT * FROM endpoints WHERE project_id = ? AND deleted_at IS NULL ORDER BY created_at', projectId),
    listByBranch: (branchId) => many<EndpointRow>('SELECT * FROM endpoints WHERE branch_id = ? AND deleted_at IS NULL ORDER BY created_at', branchId),
    listActive: () => many<EndpointRow>("SELECT * FROM endpoints WHERE deleted_at IS NULL AND current_state = 'active'"),
    readWriteFor: (branchId) => one<EndpointRow>("SELECT * FROM endpoints WHERE branch_id = ? AND type = 'read_write' AND deleted_at IS NULL", branchId),
    update(id, patch) {
      const fields = Object.keys(patch);
      if (fields.length > 0) {
        run(
          `UPDATE endpoints SET ${fields.map((field) => `${field} = ?`).join(', ')}, updated_at = ? WHERE id = ? AND deleted_at IS NULL`,
          ...fields.map((field) => (patch as Record<string, unknown>)[field]), now(), id,
        );
      }
      return endpoints.get(id);
    },
    setState(id, state, pending = null) {
      const ts = now();
      const extra = state === 'active' ? ', started_at = ?' : state === 'idle' ? ', suspended_at = ?' : '';
      const params: unknown[] = [state, pending, ts];
      if (extra) params.push(ts);
      params.push(id);
      run(`UPDATE endpoints SET current_state = ?, pending_state = ?, updated_at = ?${extra} WHERE id = ?`, ...params);
      return endpoints.get(id);
    },
    touchActivity: (id) => { run('UPDATE endpoints SET last_active = ? WHERE id = ?', now(), id); },
    usedPorts: () => many<{ pg_port: number; http_port: number }>('SELECT pg_port, http_port FROM endpoints WHERE deleted_at IS NULL')
      .flatMap((row) => [row.pg_port, row.http_port]),
    softDelete: (id) => { run('UPDATE endpoints SET deleted_at = ?, updated_at = ? WHERE id = ?', now(), now(), id); },
  };

  const roles: RoleRepo = {
    upsert(row) {
      const ts = now();
      db.prepare(
        `INSERT INTO roles (branch_id, name, password_ciphertext, scram_secret, protected, no_login, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(branch_id, name) DO UPDATE SET
           password_ciphertext = excluded.password_ciphertext,
           scram_secret = excluded.scram_secret,
           no_login = excluded.no_login,
           updated_at = excluded.updated_at`,
      ).run(row.branch_id, row.name, row.password_ciphertext, row.scram_secret, row.protected, row.no_login, ts, ts);
      return roles.get(row.branch_id, row.name) as RoleRow;
    },
    get: (branchId, name) => one<RoleRow>('SELECT * FROM roles WHERE branch_id = ? AND name = ?', branchId, name),
    listByBranch: (branchId) => many<RoleRow>('SELECT * FROM roles WHERE branch_id = ? ORDER BY created_at', branchId),
    setPassword(branchId, name, ciphertext, scram) {
      run('UPDATE roles SET password_ciphertext = ?, scram_secret = ?, updated_at = ? WHERE branch_id = ? AND name = ?', ciphertext, scram, now(), branchId, name);
      return roles.get(branchId, name);
    },
    remove: (branchId, name) => run('DELETE FROM roles WHERE branch_id = ? AND name = ?', branchId, name) > 0,
  };

  const databases: DatabaseRepo = {
    insert(row) {
      const ts = now();
      const info = db.prepare('INSERT INTO databases (branch_id, name, owner_name, created_at, updated_at) VALUES (?,?,?,?,?)')
        .run(row.branch_id, row.name, row.owner_name, ts, ts);
      return one<DatabaseRow>('SELECT * FROM databases WHERE id = ?', info.lastInsertRowid) as DatabaseRow;
    },
    get: (branchId, name) => one<DatabaseRow>('SELECT * FROM databases WHERE branch_id = ? AND name = ?', branchId, name),
    listByBranch: (branchId) => many<DatabaseRow>('SELECT * FROM databases WHERE branch_id = ? ORDER BY id', branchId),
    rename(branchId, name, patch) {
      const fields = Object.entries(patch).filter(([, value]) => value !== undefined);
      if (fields.length > 0) {
        run(
          `UPDATE databases SET ${fields.map(([field]) => `${field} = ?`).join(', ')}, updated_at = ? WHERE branch_id = ? AND name = ?`,
          ...fields.map(([, value]) => value), now(), branchId, name,
        );
      }
      return databases.get(branchId, patch.name ?? name);
    },
    remove: (branchId, name) => run('DELETE FROM databases WHERE branch_id = ? AND name = ?', branchId, name) > 0,
    ownedBy: (branchId, roleName) => many<DatabaseRow>('SELECT * FROM databases WHERE branch_id = ? AND owner_name = ?', branchId, roleName),
  };

  const operations: OperationRepo = {
    insert(input) {
      const ts = now();
      db.prepare(
        `INSERT INTO operations (id, project_id, branch_id, endpoint_id, action, status, payload_json, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      ).run(
        input.id, input.project_id, input.branch_id ?? null, input.endpoint_id ?? null, input.action,
        input.status ?? 'scheduling', JSON.stringify(input.payload ?? {}), ts, ts,
      );
      return operations.get(input.id) as OperationRow;
    },
    get: (id) => one<OperationRow>('SELECT * FROM operations WHERE id = ?', id),
    listByProject: (projectId, limit) => many<OperationRow>('SELECT * FROM operations WHERE project_id = ? ORDER BY created_at DESC LIMIT ?', projectId, limit),
    listRecent: (limit) => many<OperationRow>('SELECT * FROM operations ORDER BY created_at DESC, rowid DESC LIMIT ?', limit),
    listByIds(ids) {
      if (ids.length === 0) return [];
      return many<OperationRow>(`SELECT * FROM operations WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids);
    },
    claimNext(nowIso) {
      const candidate = one<OperationRow>(
        `SELECT * FROM operations
         WHERE status = 'scheduling' AND (retry_at IS NULL OR retry_at <= ?)
           AND NOT EXISTS (
             SELECT 1 FROM operations busy
             WHERE busy.status = 'running'
               AND busy.project_id = operations.project_id
               AND (
                 (operations.endpoint_id IS NOT NULL AND busy.endpoint_id = operations.endpoint_id)
                 OR (operations.branch_id IS NOT NULL AND busy.branch_id = operations.branch_id)
               )
           )
         ORDER BY created_at LIMIT 1`,
        nowIso,
      );
      if (!candidate) return undefined;
      const claimed = run(
        "UPDATE operations SET status = 'running', started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ? AND status = 'scheduling'",
        nowIso, nowIso, candidate.id,
      );
      return claimed > 0 ? operations.get(candidate.id) : undefined;
    },
    advance: (id, cursorStep) => { run('UPDATE operations SET cursor_step = ?, updated_at = ? WHERE id = ?', cursorStep, now(), id); },
    finish: (id, durationMs) => { run("UPDATE operations SET status = 'finished', total_duration_ms = ?, error = NULL, updated_at = ? WHERE id = ?", durationMs, now(), id); },
    fail: (id, error, durationMs) => {
      run(
        "UPDATE operations SET status = 'failed', error = ?, failures_count = failures_count + 1, total_duration_ms = ?, updated_at = ? WHERE id = ?",
        error, durationMs, now(), id,
      );
    },
    reschedule: (id, retryAt, error) => {
      run(
        "UPDATE operations SET status = 'scheduling', retry_at = ?, error = ?, failures_count = failures_count + 1, updated_at = ? WHERE id = ?",
        retryAt, error, now(), id,
      );
    },
    hasActiveFor(scope) {
      if (scope.endpoint_id) {
        return Boolean(one(`SELECT 1 AS found FROM operations WHERE endpoint_id = ? AND status IN ${ACTIVE_STATUSES}`, scope.endpoint_id));
      }
      if (scope.branch_id) {
        return Boolean(one(`SELECT 1 AS found FROM operations WHERE branch_id = ? AND status IN ${ACTIVE_STATUSES}`, scope.branch_id));
      }
      return false;
    },
  };

  const apiKeys: ApiKeyRepo = {
    insert(row) {
      const info = db.prepare(
        `INSERT INTO api_keys (name, key_hash, created_by, created_at, kind, org_id, project_id)
         VALUES (?,?,?,?,?,?,?)`,
      ).run(row.name, row.key_hash, row.created_by ?? null, now(), row.kind ?? 'user', row.org_id ?? null, row.project_id ?? null);
      return apiKeys.get(Number(info.lastInsertRowid)) as ApiKeyRow;
    },
    get: (id) => one<ApiKeyRow>('SELECT * FROM api_keys WHERE id = ?', id),
    findByHash: (hash) => one<ApiKeyRow>('SELECT * FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL', hash),
    listByUser: (userId) => many<ApiKeyRow>(
      "SELECT * FROM api_keys WHERE kind = 'user' AND created_by = ? AND revoked_at IS NULL ORDER BY id", userId,
    ),
    listByOrg: (orgId) => many<ApiKeyRow>(
      "SELECT * FROM api_keys WHERE kind = 'org' AND org_id = ? AND revoked_at IS NULL ORDER BY id", orgId,
    ),
    revoke(id) {
      run('UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', now(), id);
      return apiKeys.get(id);
    },
    touch(id, addr) {
      run('UPDATE api_keys SET last_used_at = ?, last_used_from_addr = COALESCE(?, last_used_from_addr) WHERE id = ?', now(), addr ?? null, id);
    },
    count: () => (one<{ total: number }>('SELECT COUNT(*) AS total FROM api_keys WHERE revoked_at IS NULL')?.total ?? 0),
  };

  const users: UserRepo = {
    insert(row) {
      const ts = now();
      db.prepare(
        `INSERT INTO users (id, email, name, last_name, image, password_hash, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      ).run(row.id, row.email, row.name, row.last_name, row.image, row.password_hash, ts, ts);
      return users.get(row.id) as UserRow;
    },
    get: (id) => one<UserRow>('SELECT * FROM users WHERE id = ?', id),
    getByEmail: (email) => one<UserRow>('SELECT * FROM users WHERE lower(email) = lower(?)', email),
    list: () => many<UserRow>('SELECT * FROM users ORDER BY created_at'),
    setPassword(id, hash) { run('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', hash, now(), id); },
    count: () => (one<{ total: number }>('SELECT COUNT(*) AS total FROM users')?.total ?? 0),
  };

  const organizations: OrganizationRepo = {
    insert(row) {
      const ts = now();
      db.prepare(
        `INSERT INTO organizations (id, name, handle, plan, managed_by, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?)`,
      ).run(row.id, row.name, row.handle, row.plan, row.managed_by, ts, ts);
      return organizations.get(row.id) as OrganizationRow;
    },
    get: (id) => one<OrganizationRow>('SELECT * FROM organizations WHERE id = ?', id),
    list: () => many<OrganizationRow>('SELECT * FROM organizations ORDER BY created_at'),
    count: () => (one<{ total: number }>('SELECT COUNT(*) AS total FROM organizations')?.total ?? 0),
  };

  const members: MemberRepo = {
    insert(row) {
      db.prepare('INSERT INTO members (id, org_id, user_id, role, joined_at) VALUES (?,?,?,?,?)')
        .run(row.id, row.org_id, row.user_id, row.role, now());
      return members.get(row.id) as MemberRow;
    },
    get: (id) => one<MemberRow>('SELECT * FROM members WHERE id = ?', id),
    getByUserAndOrg: (userId, orgId) => one<MemberRow>('SELECT * FROM members WHERE user_id = ? AND org_id = ?', userId, orgId),
    listByOrg: (orgId) => many<MemberRow>('SELECT * FROM members WHERE org_id = ? ORDER BY joined_at', orgId),
    listByUser: (userId) => many<MemberRow>('SELECT * FROM members WHERE user_id = ? ORDER BY joined_at', userId),
    setRole(id, role) { run('UPDATE members SET role = ? WHERE id = ?', role, id); return members.get(id); },
    remove: (id) => run('DELETE FROM members WHERE id = ?', id) > 0,
    count: () => (one<{ total: number }>('SELECT COUNT(*) AS total FROM members')?.total ?? 0),
  };

  const sessions: SessionRepo = {
    insert(row) {
      db.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at) VALUES (?,?,?,?,?)')
        .run(row.id, row.user_id, now(), row.expires_at, now());
      return sessions.get(row.id) as SessionRow;
    },
    get: (id) => one<SessionRow>('SELECT * FROM sessions WHERE id = ?', id),
    touch(id) { run('UPDATE sessions SET last_seen_at = ? WHERE id = ?', now(), id); },
    remove: (id) => run('DELETE FROM sessions WHERE id = ?', id) > 0,
    removeExpired(nowIso) { run('DELETE FROM sessions WHERE expires_at <= ?', nowIso); },
  };

  return {
    db, projects, branches, endpoints, roles, databases, operations, apiKeys,
    users, organizations, members, sessions,
    transaction: <T>(fn: () => T): T => db.transaction(fn)(),
  };
}

import type { ApiKeyRow, MemberRow, OrganizationRow, UserRow } from '../store/rows.ts';

/**
 * Row -> response views for the identity surfaces (design 004).
 *
 * The official spec is inconsistent on purpose here: `created_by` is a uuid string on the create and
 * revoke responses but an object (`{id,name,image}`) on the list items. Both shapes are implemented
 * exactly, because clients key off each independently.
 */

function creatorObject(creator: UserRow | undefined): Record<string, unknown> {
  return { id: creator?.id ?? '', name: creator?.name ?? '', image: creator?.image ?? '' };
}

export function apiKeyCreateView(row: ApiKeyRow, key: string): Record<string, unknown> {
  return {
    id: row.id,
    key,
    name: row.name,
    created_at: row.created_at,
    created_by: row.created_by ?? '',
    ...(row.project_id ? { project_id: row.project_id } : {}),
  };
}

export function apiKeyListView(row: ApiKeyRow, creator: UserRow | undefined): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    created_at: row.created_at,
    created_by: creatorObject(creator),
    last_used_at: row.last_used_at,
    last_used_from_addr: row.last_used_from_addr ?? '',
    ...(row.project_id ? { project_id: row.project_id } : {}),
  };
}

export function apiKeyRevokeView(row: ApiKeyRow): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    created_at: row.created_at,
    created_by: row.created_by ?? '',
    last_used_at: row.last_used_at,
    last_used_from_addr: row.last_used_from_addr ?? '',
    revoked: true,
    ...(row.project_id ? { project_id: row.project_id } : {}),
  };
}

export function authDetailsView(principal: { kind: 'user_key' | 'org_key' | 'session'; userId?: string; orgId?: string }): Record<string, unknown> {
  const authMethod = principal.kind === 'org_key' ? 'api_key_org' : principal.kind === 'user_key' ? 'api_key_user' : 'session_cookie';
  return { account_id: principal.userId ?? principal.orgId ?? '', auth_method: authMethod };
}

export function currentUserView(user: UserRow): Record<string, unknown> {
  return {
    active_seconds_limit: 0,
    id: user.id,
    email: user.email,
    login: user.email,
    name: user.name,
    last_name: user.last_name,
    image: user.image,
    projects_limit: 1000,
    branches_limit: 1000,
    max_autoscaling_limit: 0,
    auth_accounts: [{ provider: 'keycloak', email: user.email, name: user.name, login: user.email, image: user.image }],
    plan: 'free',
  };
}

export function organizationView(row: OrganizationRow): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    handle: row.handle,
    plan: row.plan,
    managed_by: row.managed_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function organizationsView(rows: readonly OrganizationRow[]): Record<string, unknown> {
  return { organizations: rows.map(organizationView) };
}

export function memberView(row: MemberRow): Record<string, unknown> {
  return { id: row.id, user_id: row.user_id, org_id: row.org_id, role: row.role, joined_at: row.joined_at };
}

export function memberWithUserView(row: MemberRow, user: UserRow | undefined): Record<string, unknown> {
  return { member: memberView(row), user: { email: user?.email ?? '' } };
}

export function organizationMembersView(rows: ReadonlyArray<{ member: MemberRow; user: UserRow | undefined }>): Record<string, unknown> {
  return { members: rows.map(({ member, user }) => memberWithUserView(member, user)) };
}

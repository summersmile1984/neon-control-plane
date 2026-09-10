import type { MemberRole } from '../store/rows.ts';

/**
 * Who is making a request, after the credential has been resolved (design 004).
 *
 *   user_key  — a personal API key (`kind = 'user'`); acts as its `userId`.
 *   org_key   — an organization API key (`kind = 'org'`); may be bound to one `projectId`.
 *   session   — a console session cookie; acts as its `userId`.
 *
 * `orgId` is the organization the credential is acting under. For a personal key or session it is
 * the organization selected on the request (`org_id` query) or the caller's single bootstrap org.
 */
export interface Principal {
  readonly kind: 'user_key' | 'org_key' | 'session';
  readonly userId?: string;
  readonly orgId?: string;
  readonly projectId?: string;
  readonly keyId?: number;
}

/** Only organization admins may create organization or project-scoped API keys. */
export function canManageOrgKeys(role: MemberRole | undefined): boolean {
  return role === 'admin';
}

import type { MiddlewareHandler } from 'hono';
import type { Config } from '../config.ts';
import type { Principal } from '../domain/identity.ts';
import { canManageOrgKeys } from '../domain/identity.ts';
import type { Repositories } from '../store/repo.ts';
import type { MemberRow } from '../store/rows.ts';
import type { AppEnv } from './env.ts';
import { errors } from './errors.ts';

/**
 * Credential scope enforcement (design 004).
 *
 *   personal key / session — may reach any project whose organization the user belongs to;
 *   organization key        — confined to its organization (and to one project when project-scoped);
 *   project-scoped key      — reaches exactly one project. Anything else 404s rather than 403s so a
 *                             scoped key cannot enumerate other projects.
 *
 * Cross-organization and cross-project lookups return `PROJECT_NOT_FOUND`, matching Neon's
 * "resources you cannot see do not exist" behavior.
 */

export function principalOrgIds(repos: Repositories, principal: Principal, config: Config): string[] {
  if (principal.kind === 'org_key') return principal.orgId ? [principal.orgId] : [];
  if (!principal.userId) return [];
  const ids = repos.members.listByUser(principal.userId).map((member) => member.org_id);
  return ids.length > 0 ? ids : [config.identity.orgId];
}

/** The organization a request acts under, honoring `?org_id=` and checking membership. */
export function resolveActingOrg(repos: Repositories, config: Config, principal: Principal, requested?: string): string {
  if (principal.kind === 'org_key') {
    if (principal.projectId) throw errors.forbidden('a project-scoped key cannot act on the organization');
    const orgId = principal.orgId;
    if (!orgId) throw errors.forbidden('organization key is not bound to an organization');
    if (requested && requested !== orgId) throw errors.orgNotFound(requested);
    return orgId;
  }
  if (principal.projectId) throw errors.forbidden('a project-scoped key cannot act on the organization');
  if (!principal.userId) throw errors.forbidden();
  const orgId = requested ?? config.identity.orgId;
  const member = repos.members.getByUserAndOrg(principal.userId, orgId);
  if (!member) throw errors.orgNotFound(orgId);
  return orgId;
}

export function memberFor(repos: Repositories, principal: Principal, orgId: string): MemberRow | undefined {
  if (!principal.userId) return undefined;
  return repos.members.getByUserAndOrg(principal.userId, orgId);
}

/** Throws unless the acting user is an organization admin (org/session principal). */
export function requireOrgAdmin(repos: Repositories, principal: Principal, orgId: string): MemberRow {
  const member = memberFor(repos, principal, orgId);
  if (!member || !canManageOrgKeys(member.role)) throw errors.forbidden('only organization admins can manage these API keys');
  return member;
}

/** Rejects any request for a project the principal's credential cannot see. */
export function projectGuard(repos: Repositories, config: Config): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const principal = c.get('principal');
    const projectId = c.req.param('project_id');
    if (!projectId) return next();
    if (principal.projectId && principal.projectId !== projectId) throw errors.projectNotFound(projectId);
    const project = repos.projects.get(projectId);
    if (!project) throw errors.projectNotFound(projectId);
    const projectOrg = project.org_id ?? config.identity.orgId;
    if (!principalOrgIds(repos, principal, config).includes(projectOrg)) throw errors.projectNotFound(projectId);
    return next();
  };
}

/** Rejects any request for an organization the principal's credential cannot see. */
export function orgGuard(repos: Repositories): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const principal = c.get('principal');
    const orgId = c.req.param('org_id');
    if (!orgId) return next();
    if (!repos.organizations.get(orgId)) throw errors.orgNotFound(orgId);
    if (principal.projectId) throw errors.orgNotFound(orgId);
    if (principal.kind === 'org_key') {
      if (principal.orgId !== orgId) throw errors.orgNotFound(orgId);
      return next();
    }
    if (!principal.userId || !repos.members.getByUserAndOrg(principal.userId, orgId)) throw errors.orgNotFound(orgId);
    return next();
  };
}

import type { Hono } from 'hono';
import type { AppDeps, AppEnv } from '../app.ts';
import type { MemberRole } from '../../store/rows.ts';
import { respond } from '../respond.ts';
import { errors } from '../errors.ts';
import { checkRequest, jsonBody, requiredString } from './helpers.ts';
import { requireOrgAdmin } from '../guard.ts';
import { memberView, organizationMembersView, organizationView } from '../../domain/identity-views.ts';

const ROLES: readonly MemberRole[] = ['admin', 'member', 'editor', 'viewer', 'collaborator'];

/** `/organizations/{org_id}` and its members (design 004). */
export function registerOrganizationRoutes(api: Hono<AppEnv>, deps: AppDeps): void {
  const { repos } = deps;

  const findMember = (orgId: string, memberId: string) => {
    const member = repos.members.get(memberId);
    if (!member || member.org_id !== orgId) throw errors.memberNotFound(memberId);
    return member;
  };

  api.get('/organizations/:org_id', (c) => {
    const org = repos.organizations.get(c.req.param('org_id'));
    if (!org) throw errors.orgNotFound(c.req.param('org_id'));
    return respond(c, 'Organization', organizationView(org));
  });

  api.get('/organizations/:org_id/members', (c) => {
    const orgId = c.req.param('org_id');
    const rows = repos.members.listByOrg(orgId).map((member) => ({ member, user: repos.users.get(member.user_id) }));
    return respond(c, 'OrganizationMembersResponse', organizationMembersView(rows));
  });

  api.get('/organizations/:org_id/members/:member_id', (c) => {
    return respond(c, 'Member', memberView(findMember(c.req.param('org_id'), c.req.param('member_id'))));
  });

  api.patch('/organizations/:org_id/members/:member_id', async (c) => {
    const orgId = c.req.param('org_id');
    requireOrgAdmin(repos, c.get('principal'), orgId);
    const member = findMember(orgId, c.req.param('member_id'));
    const body = await jsonBody(c);
    checkRequest('OrganizationMemberUpdateRequest', body);
    const role = requiredString(body, 'role') as MemberRole;
    if (!ROLES.includes(role)) throw errors.badRequest(`role must be one of ${ROLES.join(', ')}`);
    guardLastAdmin(orgId, member.id, role);
    return respond(c, 'Member', memberView(repos.members.setRole(member.id, role)!));
  });

  api.delete('/organizations/:org_id/members/:member_id', (c) => {
    const orgId = c.req.param('org_id');
    requireOrgAdmin(repos, c.get('principal'), orgId);
    const member = findMember(orgId, c.req.param('member_id'));
    guardLastAdmin(orgId, member.id, undefined);
    repos.members.remove(member.id);
    return respond(c, 'EmptyResponse', {});
  });

  /** Refuses a change that would leave the organization with no admin. */
  function guardLastAdmin(orgId: string, memberId: string, nextRole: MemberRole | undefined): void {
    const member = repos.members.get(memberId);
    if (member?.role !== 'admin') return;
    const others = repos.members.listByOrg(orgId).filter((row) => row.role === 'admin' && row.id !== memberId);
    if (others.length === 0 && nextRole !== 'admin') {
      throw errors.badRequest('the organization must keep at least one admin');
    }
  }
}

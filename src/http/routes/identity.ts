import type { Hono } from 'hono';
import type { AppDeps, AppEnv } from '../app.ts';
import { respond } from '../respond.ts';
import { errors } from '../errors.ts';
import { authDetailsView, currentUserView, organizationsView } from '../../domain/identity-views.ts';

/** `/auth`, `/users/me`, `/users/me/organizations` (design 004). */
export function registerIdentityRoutes(api: Hono<AppEnv>, deps: AppDeps): void {
  const { repos } = deps;

  api.get('/auth', (c) => respond(c, 'AuthDetailsResponse', authDetailsView(c.get('principal'))));

  api.get('/users/me', (c) => {
    const principal = c.get('principal');
    if (!principal.userId) throw errors.forbidden('organization API keys cannot read the current user');
    const user = repos.users.get(principal.userId);
    if (!user) throw errors.notFound('user');
    return respond(c, 'CurrentUserInfoResponse', currentUserView(user));
  });

  api.get('/users/me/organizations', (c) => {
    const principal = c.get('principal');
    if (!principal.userId) throw errors.forbidden('organization API keys cannot list user organizations');
    const orgs = repos.members.listByUser(principal.userId)
      .map((member) => repos.organizations.get(member.org_id))
      .filter((org): org is NonNullable<typeof org> => org !== undefined);
    return respond(c, 'OrganizationsResponse', organizationsView(orgs));
  });
}

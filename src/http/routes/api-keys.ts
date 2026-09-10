import type { Hono } from 'hono';
import type { AppDeps, AppEnv } from '../app.ts';
import type { Principal } from '../../domain/identity.ts';
import { respond, respondList } from '../respond.ts';
import { errors } from '../errors.ts';
import { checkRequest, jsonBody, optionalString, requiredString } from './helpers.ts';
import { resolveActingOrg, requireOrgAdmin } from '../guard.ts';
import { apiKeyCreateView, apiKeyListView, apiKeyRevokeView } from '../../domain/identity-views.ts';
import { generateApiKey, hashApiKey } from '../auth.ts';

/** `/api_keys` and `/organizations/{org_id}/api_keys` (design 004). */
export function registerApiKeyRoutes(api: Hono<AppEnv>, deps: AppDeps): void {
  const { repos, config } = deps;

  const parseKeyId = (raw: string | undefined): number => {
    const id = Number(raw);
    if (!raw || !Number.isInteger(id) || id <= 0) throw errors.notFound('API key');
    return id;
  };
  const personalOwner = (principal: Principal): string => {
    if (!principal.userId) throw errors.forbidden('organization API keys cannot manage personal API keys');
    return principal.userId;
  };
  const revoke = (id: number) => {
    const row = repos.apiKeys.revoke(id);
    if (!row) throw errors.notFound('API key');
    return row;
  };

  api.get('/api_keys', (c) => {
    const userId = personalOwner(c.get('principal'));
    const rows = repos.apiKeys.listByUser(userId);
    return respondList(c, 'ApiKeysListResponseItem', rows.map((row) => apiKeyListView(row, repos.users.get(row.created_by ?? ''))));
  });

  api.post('/api_keys', async (c) => {
    const userId = personalOwner(c.get('principal'));
    const body = await jsonBody(c);
    checkRequest('ApiKeyCreateRequest', body);
    const name = requiredString(body, 'key_name');
    const key = generateApiKey(config.identity.keyPrefix);
    const row = repos.apiKeys.insert({ name, key_hash: hashApiKey(key), created_by: userId, kind: 'user' });
    return respond(c, 'ApiKeyCreateResponse', apiKeyCreateView(row, key));
  });

  api.delete('/api_keys/:key_id', (c) => {
    const userId = personalOwner(c.get('principal'));
    const id = parseKeyId(c.req.param('key_id'));
    const row = repos.apiKeys.get(id);
    if (!row || row.revoked_at || row.kind !== 'user' || row.created_by !== userId) throw errors.notFound('API key');
    return respond(c, 'ApiKeyRevokeResponse', apiKeyRevokeView(revoke(id)));
  });

  api.get('/organizations/:org_id/api_keys', (c) => {
    const orgId = resolveActingOrg(repos, config, c.get('principal'), c.req.param('org_id'));
    const rows = repos.apiKeys.listByOrg(orgId);
    return respondList(c, 'OrgApiKeysListResponseItem', rows.map((row) => apiKeyListView(row, repos.users.get(row.created_by ?? ''))));
  });

  api.post('/organizations/:org_id/api_keys', async (c) => {
    const principal = c.get('principal');
    const orgId = resolveActingOrg(repos, config, principal, c.req.param('org_id'));
    requireOrgAdmin(repos, principal, orgId);
    const body = await jsonBody(c);
    checkRequest('OrgApiKeyCreateRequest', body);
    const name = requiredString(body, 'key_name');
    const projectId = optionalString(body, 'project_id');
    if (projectId) {
      const project = repos.projects.get(projectId);
      if (!project || (project.org_id ?? config.identity.orgId) !== orgId) throw errors.projectNotFound(projectId);
    }
    const key = generateApiKey(config.identity.keyPrefix);
    const row = repos.apiKeys.insert({
      name, key_hash: hashApiKey(key), created_by: principal.userId ?? null,
      kind: 'org', org_id: orgId, project_id: projectId ?? null,
    });
    return respond(c, 'OrgApiKeyCreateResponse', apiKeyCreateView(row, key));
  });

  api.delete('/organizations/:org_id/api_keys/:key_id', (c) => {
    const principal = c.get('principal');
    const orgId = resolveActingOrg(repos, config, principal, c.req.param('org_id'));
    requireOrgAdmin(repos, principal, orgId);
    const id = parseKeyId(c.req.param('key_id'));
    const row = repos.apiKeys.get(id);
    if (!row || row.revoked_at || row.kind !== 'org' || row.org_id !== orgId) throw errors.notFound('API key');
    return respond(c, 'OrgApiKeyRevokeResponse', apiKeyRevokeView(revoke(id)));
  });
}

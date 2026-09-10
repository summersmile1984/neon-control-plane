import { randomUUID } from 'node:crypto';
import type { IdentityConfig } from '../config.ts';
import type { Logger } from '../logger.ts';
import { hashApiKey } from '../http/auth.ts';
import { hashPassword } from './session.ts';
import type { Repositories } from '../store/repo.ts';

/**
 * First-run seeding (design 004).
 *
 * The control plane always requires auth, so a fresh database would be unusable. Startup seeds one
 * organization and one owner member, and — when configured — that owner's first personal API key.
 * Idempotent: it only fills gaps, so restarts and re-runs never duplicate or rotate anything.
 */
export function bootstrapIdentity(repos: Repositories, identity: IdentityConfig, logger: Logger): void {
  repos.transaction(() => {
    if (!repos.organizations.get(identity.orgId)) {
      repos.organizations.insert({
        id: identity.orgId,
        name: identity.orgName,
        handle: identity.orgId,
        plan: 'free',
        managed_by: 'console',
      });
      logger.info('seeded bootstrap organization', { org_id: identity.orgId });
    }

    if (!repos.users.get(identity.ownerId)) {
      repos.users.insert({
        id: identity.ownerId,
        email: identity.ownerEmail,
        name: identity.ownerName,
        last_name: identity.ownerLastName,
        image: '',
        password_hash: identity.ownerPassword ? hashPassword(identity.ownerPassword) : null,
      });
      logger.info('seeded bootstrap owner', { user_id: identity.ownerId, email: identity.ownerEmail });
    } else if (identity.ownerPassword) {
      repos.users.setPassword(identity.ownerId, hashPassword(identity.ownerPassword));
    }

    if (!repos.members.getByUserAndOrg(identity.ownerId, identity.orgId)) {
      repos.members.insert({ id: randomUUID(), org_id: identity.orgId, user_id: identity.ownerId, role: 'admin' });
    }

    if (identity.bootstrapApiKey) {
      const hash = hashApiKey(identity.bootstrapApiKey);
      if (!repos.apiKeys.findByHash(hash)) {
        repos.apiKeys.insert({ name: 'bootstrap', key_hash: hash, created_by: identity.ownerId, kind: 'user' });
        logger.info('seeded bootstrap API key', { prefix: identity.bootstrapApiKey.slice(0, identity.keyPrefix.length) });
      }
    }
  });
}

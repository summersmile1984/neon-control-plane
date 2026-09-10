import type { Principal } from '../domain/identity.ts';

/** Shared Hono environment for every route module (kept separate to avoid an app.ts/auth.ts cycle). */
export type AppEnv = {
  Variables: {
    requestId: string;
    principal: Principal;
    apiKeyId?: number;
  };
};

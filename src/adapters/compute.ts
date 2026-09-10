import { request } from 'undici';
import type { ComputeSigner } from '../domain/compute-auth.ts';
import type { ComputeSpecEnvelope } from '../domain/spec-builder.ts';

/**
 * compute_ctl HTTP client (002 §7.2). Every call carries a bearer JWT signed by the control
 * plane's Ed25519 key, with a `compute_id` claim equal to the container's `--compute-id`
 * (docs/notes/M0-compute-findings.md).
 */

export type ComputeStatus =
  | 'empty' | 'configuration_pending' | 'init' | 'running' | 'configuration' | 'failed'
  | 'termination_pending_fast' | 'termination_pending_immediate' | 'terminated';

export interface ComputeStatusResponse {
  readonly status: ComputeStatus;
  readonly start_time?: string;
  readonly tenant?: string;
  readonly timeline?: string;
  readonly last_active?: string | null;
  readonly error?: string | null;
}

export class ComputeError extends Error {
  public readonly status: number | undefined;
  public constructor(message: string, status?: number) {
    super(message);
    this.name = 'ComputeError';
    this.status = status;
  }
}

export interface ComputeTarget {
  /** e.g. `http://127.0.0.1:55601` (host published) or `http://ep-xxx:3080` (in-network). */
  readonly baseUrl: string;
  /** Must equal the container's `--compute-id`. */
  readonly computeId: string;
}

export interface ComputeClient {
  status(target: ComputeTarget): Promise<ComputeStatusResponse>;
  waitForStatus(target: ComputeTarget, wanted: ComputeStatus, timeoutMs: number): Promise<ComputeStatusResponse>;
  configure(target: ComputeTarget, spec: ComputeSpecEnvelope): Promise<ComputeStatusResponse>;
  terminate(target: ComputeTarget, mode?: 'fast' | 'immediate'): Promise<void>;
  dbsAndRoles(target: ComputeTarget): Promise<{ roles: unknown[]; databases: unknown[] }>;
}

export interface ComputeClientOptions {
  readonly signer: ComputeSigner;
  readonly timeoutMs?: number;
}

export function createComputeClient(options: ComputeClientOptions): ComputeClient {
  const timeout = options.timeoutMs ?? 30_000;

  async function call<T>(target: ComputeTarget, method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { authorization: `Bearer ${options.signer.token(target.computeId)}` };
    if (body !== undefined) headers['content-type'] = 'application/json';
    let response;
    try {
      response = await request(`${target.baseUrl.replace(/\/+$/, '')}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        headersTimeout: timeout,
        bodyTimeout: timeout,
      });
    } catch (cause) {
      throw new ComputeError(`compute ${method} ${path} failed: ${String(cause)}`);
    }
    const text = await response.body.text();
    if (response.statusCode >= 400) throw new ComputeError(`compute ${method} ${path} -> ${response.statusCode} ${text.slice(0, 300)}`, response.statusCode);
    return (text ? JSON.parse(text) : undefined) as T;
  }

  return {
    status: (target) => call<ComputeStatusResponse>(target, 'GET', '/status'),

    async waitForStatus(target, wanted, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      let last: ComputeStatusResponse | undefined;
      let lastError = '';
      while (Date.now() < deadline) {
        try {
          last = await call<ComputeStatusResponse>(target, 'GET', '/status');
          if (last.status === wanted) return last;
          if (last.status === 'failed') throw new ComputeError(`compute reported failed: ${last.error ?? 'no detail'}`);
        } catch (error) {
          if (error instanceof ComputeError && error.message.includes('reported failed')) throw error;
          lastError = error instanceof Error ? error.message : String(error);
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      throw new ComputeError(`compute did not reach ${wanted} within ${timeoutMs}ms (last=${last?.status ?? 'unreachable'}${lastError ? `, ${lastError.slice(0, 120)}` : ''})`);
    },

    configure: (target, spec) => call<ComputeStatusResponse>(target, 'POST', '/configure', spec),

    async terminate(target, mode = 'fast') {
      try {
        await call(target, 'POST', `/terminate?mode=${mode}`);
      } catch (error) {
        // The process exits while answering, so a dropped connection here is the expected outcome.
        if (error instanceof ComputeError && error.status === undefined) return;
        throw error;
      }
    },

    dbsAndRoles: (target) => call<{ roles: unknown[]; databases: unknown[] }>(target, 'GET', '/dbs_and_roles'),
  };
}

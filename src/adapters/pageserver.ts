import { request } from 'undici';

/**
 * pageserver HTTP client (002 §7.1). Paths come from pageserver/src/http/openapi_spec.yml.
 * This adapter translates protocol and classifies failures; it never touches the database.
 */

export type PageserverFailureKind = 'not_found' | 'conflict' | 'invalid' | 'retryable';

export class PageserverError extends Error {
  public readonly kind: PageserverFailureKind;
  public readonly status: number | undefined;

  public constructor(kind: PageserverFailureKind, message: string, status?: number) {
    super(message);
    this.name = 'PageserverError';
    this.kind = kind;
    this.status = status;
  }
}

export interface TimelineInfo {
  readonly timeline_id: string;
  readonly tenant_id?: string;
  readonly ancestor_timeline_id?: string;
  readonly ancestor_lsn?: string;
  readonly last_record_lsn?: string;
  readonly current_logical_size?: number;
  readonly [key: string]: unknown;
}

export interface LocationConfigBody {
  readonly mode: 'AttachedSingle' | 'AttachedMulti' | 'AttachedStale' | 'Secondary' | 'Detached';
  readonly generation: number;
  readonly tenant_conf: Record<string, unknown>;
  readonly secondary_conf?: Record<string, unknown> | null;
}

export interface CreateTimelineBody {
  readonly new_timeline_id: string;
  readonly pg_version?: number;
  readonly ancestor_timeline_id?: string;
  readonly ancestor_start_lsn?: string;
}

/** `kind` distinguishes an exact match from a clamp at either end of the retained history. */
export interface LsnByTimestamp {
  readonly lsn?: string;
  readonly kind?: string;
  readonly [key: string]: unknown;
}

export interface PageserverClient {
  status(): Promise<Record<string, unknown>>;
  listTenants(): Promise<Array<{ id: string }>>;
  locationConfig(tenantId: string, body: LocationConfigBody): Promise<void>;
  deleteTenant(tenantId: string): Promise<void>;
  listTimelines(tenantId: string): Promise<TimelineInfo[]>;
  createTimeline(tenantId: string, body: CreateTimelineBody): Promise<TimelineInfo>;
  getTimeline(tenantId: string, timelineId: string): Promise<TimelineInfo>;
  deleteTimeline(tenantId: string, timelineId: string): Promise<void>;
  getLsnByTimestamp(tenantId: string, timelineId: string, timestamp: string): Promise<LsnByTimestamp>;
}

export interface PageserverClientOptions {
  readonly baseUrl: string;
  readonly timeoutMs?: number;
  readonly authToken?: string;
}

function classify(status: number, body: string): PageserverError {
  if (status === 404) return new PageserverError('not_found', body, status);
  if (status === 409) return new PageserverError('conflict', body, status);
  if (status === 400 || status === 422) return new PageserverError('invalid', body, status);
  return new PageserverError('retryable', body, status);
}

export function createPageserverClient(options: PageserverClientOptions): PageserverClient {
  const base = options.baseUrl.replace(/\/+$/, '');
  const timeout = options.timeoutMs ?? 30_000;

  async function call<T>(method: 'GET' | 'PUT' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (options.authToken) headers.authorization = `Bearer ${options.authToken}`;

    let response;
    try {
      response = await request(`${base}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        headersTimeout: timeout,
        bodyTimeout: timeout,
      });
    } catch (cause) {
      throw new PageserverError('retryable', `pageserver ${method} ${path} failed: ${String(cause)}`);
    }

    const text = await response.body.text();
    if (response.statusCode >= 400) throw classify(response.statusCode, text.slice(0, 500));
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new PageserverError('invalid', `pageserver ${method} ${path} returned non-JSON`);
    }
  }

  return {
    status: () => call('GET', '/v1/status'),
    listTenants: () => call('GET', '/v1/tenant'),
    // PUT .../location_config is how the official compose attaches a tenant without a storage
    // controller: mode AttachedSingle, generation 1 (002 §3, 卡点 3).
    locationConfig: (tenantId, body) => call('PUT', `/v1/tenant/${tenantId}/location_config`, body),
    deleteTenant: (tenantId) => call('DELETE', `/v1/tenant/${tenantId}`),
    listTimelines: (tenantId) => call('GET', `/v1/tenant/${tenantId}/timeline`),
    createTimeline: (tenantId, body) => call('POST', `/v1/tenant/${tenantId}/timeline/`, body),
    getTimeline: (tenantId, timelineId) => call('GET', `/v1/tenant/${tenantId}/timeline/${timelineId}`),
    deleteTimeline: (tenantId, timelineId) => call('DELETE', `/v1/tenant/${tenantId}/timeline/${timelineId}`),
    getLsnByTimestamp: (tenantId, timelineId, timestamp) =>
      call('GET', `/v1/tenant/${tenantId}/timeline/${timelineId}/get_lsn_by_timestamp?timestamp=${encodeURIComponent(timestamp)}`),
  };
}

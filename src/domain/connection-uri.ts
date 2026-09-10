/**
 * Connection string assembly for the three routing tiers (001 §3.3, 002 §6).
 *
 *   direct      postgresql://role:pw@127.0.0.1:<hostPort>/db?sslmode=disable
 *   sni-router  postgresql://role:pw@<ep>--compute--55433.<zone>:5432/db?sslmode=require
 *   proxy       postgresql://role:pw@<ep>.<zone>:5432/db?sslmode=require
 *
 * `pg_sni_router` parses the first SNI label as `<service>--<namespace>--<port>` and forwards to
 * `<service>.<namespace>.<destination>:<port>`; the compute container is named after the endpoint
 * id and listens on 55433 inside the network.
 *
 * `sni-router` is kept for a Kubernetes deployment, where that three-part label matches a Service
 * DNS name. The local compose stack ships no router for it (T-201): measured on build 8464,
 * pg_sni_router panics on the plain `<ep>.<zone>` host a Neon connection string carries, and it
 * neither authenticates nor wakes a suspended compute. Local development uses `proxy`.
 */

export type RouteMode = 'direct' | 'sni-router' | 'proxy';

export const COMPUTE_INTERNAL_PORT = 55433;
export const ROUTER_PORT = 5432;

export interface EndpointAddress {
  readonly id: string;
  /** Host port the control plane published for the container; only used by `direct`. */
  readonly pgPort: number;
}

export interface ConnectionUriInput {
  readonly mode: RouteMode;
  readonly zone: string;
  readonly endpoint: EndpointAddress;
  readonly database: string;
  readonly role: string;
  readonly password: string;
  readonly pooled?: boolean;
}

export interface ConnectionParameters {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly role: string;
  readonly password: string;
  readonly sslmode: 'require' | 'disable';
}

/** The `Endpoint.host` value stored on the row and returned by the API. */
export function endpointHost(mode: RouteMode, zone: string, endpointId: string, pooled = false): string {
  const id = pooled ? `${endpointId}-pooler` : endpointId;
  switch (mode) {
    case 'direct':
      return '127.0.0.1';
    case 'sni-router':
      return `${id}--compute--${COMPUTE_INTERNAL_PORT}.${zone}`;
    case 'proxy':
      return `${id}.${zone}`;
  }
}

export function connectionParameters(input: ConnectionUriInput): ConnectionParameters {
  const pooled = input.pooled ?? false;
  const direct = input.mode === 'direct';
  return {
    host: endpointHost(input.mode, input.zone, input.endpoint.id, pooled),
    port: direct ? input.endpoint.pgPort : ROUTER_PORT,
    database: input.database,
    role: input.role,
    password: input.password,
    sslmode: direct ? 'disable' : 'require',
  };
}

export function buildConnectionUri(input: ConnectionUriInput): string {
  const parameters = connectionParameters(input);
  const user = encodeURIComponent(parameters.role);
  const password = encodeURIComponent(parameters.password);
  const database = encodeURIComponent(parameters.database);
  if (parameters.sslmode === 'disable') {
    // direct mode publishes the compute port on the host and speaks plain TCP
    return `postgresql://${user}:${password}@${parameters.host}:${parameters.port}/${database}?sslmode=disable`;
  }
  // Routed modes match the shape Neon Cloud emits: no explicit port, sslmode and channel_binding
  // both required. Consumers parse this string, so the extra parameter is part of the contract.
  return `postgresql://${user}:${password}@${parameters.host}/${database}?sslmode=require&channel_binding=require`;
}

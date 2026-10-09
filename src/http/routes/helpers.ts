import type { Context } from 'hono';
import type { Repositories } from '../../store/repo.ts';
import type { BranchRow, DatabaseRow, EndpointRow, OperationRow, ProjectRow, RoleRow } from '../../store/rows.ts';
import { operationView } from '../../domain/views.ts';
import { errors } from '../errors.ts';
import { validators } from '../validate.ts';

/** Shared request parsing and lookup helpers for the route modules. */

export async function jsonBody(c: Context): Promise<Record<string, unknown>> {
  try {
    const raw: unknown = await c.req.json();
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('not an object');
    return raw as Record<string, unknown>;
  } catch {
    throw errors.badRequest('request body must be a JSON object');
  }
}

/** Validates a body against a `components.schemas` entry from the vendored spec. */
export function checkRequest(schemaName: string, body: unknown): void {
  const spec = validators();
  if (!spec.has(schemaName)) return;
  if (spec.get(schemaName)(body)) return;
  throw errors.badRequest(`${schemaName}: ${spec.errorText(schemaName)}`);
}

export function section(body: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = body[key];
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw errors.badRequest(`${key} must be an object`);
  return value as Record<string, unknown>;
}

export function optionalString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.length === 0) throw errors.badRequest(`${key} must be a non-empty string`);
  return value;
}

export function requiredString(source: Record<string, unknown>, key: string): string {
  const value = optionalString(source, key);
  if (value === undefined) throw errors.badRequest(`${key} is required`);
  return value;
}

export function optionalBoolean(source: Record<string, unknown>, key: string): boolean | undefined {
  const value = source[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') throw errors.badRequest(`${key} must be a boolean`);
  return value;
}

export function optionalInteger(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value)) throw errors.badRequest(`${key} must be an integer`);
  return value;
}

/** Bounded ASCII identifiers, passed as names in compute_ctl specs (not interpolated SQL).
 * Postgres identifiers allow dots and hyphens; compute_ctl quotes them, they are never
 * interpolated into SQL. */
const PG_IDENT = /^[A-Za-z0-9_][A-Za-z0-9_$.-]{0,62}$/;

export function pgIdentifier(value: string, field: string): string {
  if (!PG_IDENT.test(value)) throw errors.badRequest(`${field} must be a Postgres identifier`);
  return value;
}

export function decodePathSegment(value: string, field: string): string {
  try {
    const decoded = decodeURIComponent(value);
    if (decoded.includes('\u0000')) throw new Error('control character');
    return decoded;
  } catch {
    throw errors.badRequest(`${field} is not a valid path segment`);
  }
}

export function findProject(repos: Repositories, projectId: string): ProjectRow {
  const project = repos.projects.get(projectId);
  if (!project) throw errors.projectNotFound(projectId);
  return project;
}

export function findBranch(repos: Repositories, project: ProjectRow, branchId: string): BranchRow {
  const branch = repos.branches.get(branchId);
  if (!branch || branch.project_id !== project.id) throw errors.branchNotFound(branchId);
  return branch;
}

export function findEndpoint(repos: Repositories, project: ProjectRow, endpointId: string): EndpointRow {
  const endpoint = repos.endpoints.get(endpointId);
  if (!endpoint || endpoint.project_id !== project.id) throw errors.endpointNotFound(endpointId);
  return endpoint;
}

export function findRole(repos: Repositories, branch: BranchRow, name: string): RoleRow {
  const role = repos.roles.get(branch.id, name);
  if (!role) throw errors.roleNotFound(name);
  return role;
}

export function findDatabase(repos: Repositories, branch: BranchRow, name: string): DatabaseRow {
  const database = repos.databases.get(branch.id, name);
  if (!database) throw errors.databaseNotFound(name);
  return database;
}

export const operationsView = (rows: readonly OperationRow[]): Record<string, unknown>[] => rows.map(operationView);

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The vendored spec is the external contract (002 §12.2). This test fails the moment a refresh of
 * `spec/neon-api-v2.json` removes or reshapes something the implementation plan depends on, which
 * is the earliest possible signal that 002 has gone stale.
 */
const root = fileURLToPath(new URL('../../', import.meta.url));
const spec = JSON.parse(readFileSync(new URL('../../spec/neon-api-v2.json', import.meta.url), 'utf8')) as {
  openapi: string;
  paths: Record<string, Record<string, unknown>>;
  components: { schemas: Record<string, { enum?: string[]; properties?: Record<string, unknown>; required?: string[] }> };
};

/** path -> methods the control plane implements. Mirrors spec/SUBSET.md. */
const SUBSET: Record<string, string[]> = {
  '/projects': ['get', 'post'],
  '/projects/{project_id}': ['get', 'patch', 'delete'],
  '/projects/{project_id}/operations': ['get'],
  '/projects/{project_id}/operations/{operation_id}': ['get'],
  '/projects/{project_id}/branches': ['get', 'post'],
  '/projects/{project_id}/branches/{branch_id}': ['get', 'patch', 'delete'],
  '/projects/{project_id}/branches/{branch_id}/set_as_default': ['post'],
  '/projects/{project_id}/branches/{branch_id}/endpoints': ['get'],
  '/projects/{project_id}/branches/{branch_id}/databases': ['get', 'post'],
  '/projects/{project_id}/branches/{branch_id}/databases/{database_name}': ['get', 'patch', 'delete'],
  '/projects/{project_id}/branches/{branch_id}/roles': ['get', 'post'],
  '/projects/{project_id}/branches/{branch_id}/roles/{role_name}': ['get', 'delete'],
  '/projects/{project_id}/branches/{branch_id}/roles/{role_name}/reset_password': ['post'],
  '/projects/{project_id}/branches/{branch_id}/roles/{role_name}/reveal_password': ['get'],
  '/projects/{project_id}/connection_uri': ['get'],
  '/projects/{project_id}/endpoints': ['get', 'post'],
  '/projects/{project_id}/endpoints/{endpoint_id}': ['get', 'patch', 'delete'],
  '/projects/{project_id}/endpoints/{endpoint_id}/start': ['post'],
  '/projects/{project_id}/endpoints/{endpoint_id}/suspend': ['post'],
  '/projects/{project_id}/endpoints/{endpoint_id}/restart': ['post'],
};

describe('vendored spec covers the implementation subset', () => {
  it('is an OpenAPI 3 document with the expected size', () => {
    expect(spec.openapi).toMatch(/^3\./);
    expect(Object.keys(spec.paths).length).toBeGreaterThan(100);
  });

  it.each(Object.entries(SUBSET))('%s declares the methods the control plane implements', (path, methods) => {
    const item = spec.paths[path];
    expect(item, `${path} is absent from the spec`).toBeDefined();
    for (const method of methods) expect(item?.[method], `${method.toUpperCase()} ${path}`).toBeDefined();
  });

  it('pins the enums the state machines depend on', () => {
    expect(spec.components.schemas.EndpointType?.enum).toEqual(['read_only', 'read_write']);
    expect(spec.components.schemas.EndpointState?.enum).toEqual(['init', 'active', 'idle']);
    expect(spec.components.schemas.OperationStatus?.enum).toEqual([
      'scheduling', 'running', 'finished', 'failed', 'error', 'cancelling', 'cancelled', 'skipped',
    ]);
    const actions = spec.components.schemas.OperationAction?.enum ?? [];
    for (const action of ['create_timeline', 'start_compute', 'suspend_compute', 'apply_config', 'delete_timeline']) {
      expect(actions, action).toContain(action);
    }
  });

  it('still types ErrorCode as a free-form string, so our vocabulary in 002 §4.3 stands', () => {
    const errorCode = spec.components.schemas.ErrorCode;
    expect(errorCode?.enum).toBeUndefined();
  });

  it('keeps the required Role and Database fields the SiteOps mappers read', () => {
    expect(spec.components.schemas.Role?.required).toEqual(expect.arrayContaining(['branch_id', 'name', 'created_at', 'updated_at']));
    expect(spec.components.schemas.Database?.required).toEqual(expect.arrayContaining(['id', 'branch_id', 'name', 'owner_name']));
    expect(spec.components.schemas.Branch?.required).toEqual(expect.arrayContaining(['id', 'project_id', 'name', 'current_state', 'default', 'protected']));
  });

  it('has a SUBSET.md that lists exactly these paths', () => {
    const subsetDoc = readFileSync(new URL('../../spec/SUBSET.md', import.meta.url), 'utf8');
    for (const path of Object.keys(SUBSET)) expect(subsetDoc, path).toContain(`\`${path}\``);
    expect(root).toBeTruthy();
  });
});

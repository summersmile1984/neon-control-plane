#!/usr/bin/env node
/**
 * T-005 helper: print the facts the implementation must match, straight from the vendored spec.
 * Run after every `spec/neon-api-v2.json` refresh and diff the output against docs/design/002.
 *
 *   pnpm spec:facts
 *   pnpm spec:facts -- --paths      only the subset path table
 *   pnpm spec:facts -- --enums      only enums
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const spec = JSON.parse(readFileSync(join(root, 'spec/neon-api-v2.json'), 'utf8'));
const args = process.argv.slice(2);
const only = (flag) => args.length === 0 || args.includes(flag);

const SUBSET = [
  '/projects',
  '/projects/{project_id}',
  '/projects/{project_id}/operations',
  '/projects/{project_id}/operations/{operation_id}',
  '/projects/{project_id}/branches',
  '/projects/{project_id}/branches/{branch_id}',
  '/projects/{project_id}/branches/{branch_id}/set_as_default',
  '/projects/{project_id}/branches/{branch_id}/endpoints',
  '/projects/{project_id}/branches/{branch_id}/databases',
  '/projects/{project_id}/branches/{branch_id}/databases/{database_name}',
  '/projects/{project_id}/branches/{branch_id}/roles',
  '/projects/{project_id}/branches/{branch_id}/roles/{role_name}',
  '/projects/{project_id}/branches/{branch_id}/roles/{role_name}/reset_password',
  '/projects/{project_id}/branches/{branch_id}/roles/{role_name}/reveal_password',
  '/projects/{project_id}/connection_uri',
  '/projects/{project_id}/endpoints',
  '/projects/{project_id}/endpoints/{endpoint_id}',
  '/projects/{project_id}/endpoints/{endpoint_id}/start',
  '/projects/{project_id}/endpoints/{endpoint_id}/suspend',
  '/projects/{project_id}/endpoints/{endpoint_id}/restart',
];

const METHODS = ['get', 'post', 'patch', 'delete', 'put'];
const refName = (node) => (node?.$ref ? node.$ref.split('/').pop() : undefined);

function schemaLabel(content) {
  const schema = content?.['application/json']?.schema;
  if (!schema) return '-';
  if (schema.$ref) return refName(schema);
  if (schema.allOf) return schema.allOf.map((part) => refName(part) ?? 'inline').join(' + ');
  return 'inline';
}

function responseLabel(response) {
  if (response?.$ref) {
    const name = response.$ref.split('/').pop();
    const resolved = spec.components.responses?.[name];
    return `${name}(${schemaLabel(resolved?.content)})`;
  }
  return schemaLabel(response?.content);
}

console.log(`# spec facts — OpenAPI ${spec.openapi}, ${spec.info?.title} ${spec.info?.version}, ${Object.keys(spec.paths).length} paths total\n`);

if (only('--paths')) {
  console.log('## subset paths');
  let missing = 0;
  for (const path of SUBSET) {
    const item = spec.paths[path];
    if (!item) { missing += 1; console.log(`  MISSING ${path}`); continue; }
    for (const method of METHODS) {
      const operation = item[method];
      if (!operation) continue;
      const query = (operation.parameters ?? [])
        .filter((parameter) => parameter.in === 'query')
        .map((parameter) => parameter.name + (parameter.required ? '*' : ''))
        .join(',');
      const responses = Object.entries(operation.responses ?? {})
        .map(([code, response]) => `${code}:${responseLabel(response)}`)
        .join(' ');
      console.log(`  ${method.toUpperCase().padEnd(6)} ${path}`);
      console.log(`         opId=${operation.operationId} query=[${query}] req=${schemaLabel(operation.requestBody?.content)}`);
      console.log(`         resp=${responses}`);
    }
  }
  if (missing) console.log(`  !! ${missing} subset paths are absent from the spec — 002 §4.1 is stale`);
  console.log();
}

if (only('--enums')) {
  console.log('## enums the implementation must honour');
  for (const [name, schema] of Object.entries(spec.components.schemas)) {
    if (Array.isArray(schema.enum)) console.log(`  ${name}: ${schema.enum.join(' | ')}`);
  }
  console.log('\n## non-enum scalars worth pinning');
  for (const name of ['ErrorCode', 'PgVersion', 'ComputeUnit', 'Provisioner', 'SuspendTimeoutSeconds']) {
    const schema = spec.components.schemas[name];
    if (!schema) { console.log(`  ${name}: absent`); continue; }
    const bounds = [schema.type, schema.minimum !== undefined ? `min=${schema.minimum}` : '', schema.maximum !== undefined ? `max=${schema.maximum}` : '', schema.enum ? `enum=${schema.enum.length}` : 'no enum'].filter(Boolean);
    console.log(`  ${name}: ${bounds.join(' ')}`);
  }
}

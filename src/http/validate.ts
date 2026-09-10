import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Ajv, { type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';

/**
 * Request and response validation against the vendored official OpenAPI (002 §4.2).
 *
 * Two namespaces:
 *   'Branch', 'BranchOperations', …            -> components.schemas.*
 *   'responses:CreatedProject', …              -> components.responses.*.content['application/json'].schema
 *
 * The spec is OpenAPI 3.0, whose schema dialect is a JSON Schema draft-04 variant. Ajv is run in
 * non-strict mode and the few 3.0-only keywords are normalised below, which is enough for the
 * subset this control plane serves.
 */

const SPEC_URL = new URL('../../spec/neon-api-v2.json', import.meta.url);

interface OpenApiDocument {
  components: {
    schemas: Record<string, unknown>;
    responses?: Record<string, { content?: Record<string, { schema?: unknown }> }>;
  };
}

export interface SpecValidators {
  /** Validator for a `components.schemas` entry, or `responses:<Name>` for a composed response. */
  get(schemaName: string): ValidateFunction;
  has(schemaName: string): boolean;
  errorText(schemaName: string): string;
}

export function loadSpec(): OpenApiDocument {
  return JSON.parse(readFileSync(fileURLToPath(SPEC_URL), 'utf8')) as OpenApiDocument;
}

/** OpenAPI 3.0 `nullable: true` becomes a JSON Schema union; `example` and `xml` are dropped. */
function normalise(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(normalise);
  if (!node || typeof node !== 'object') return node;
  const source = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (key === 'example' || key === 'examples' || key === 'xml' || key === 'discriminator' || key === 'externalDocs') continue;
    if (key === 'nullable') continue;
    out[key] = normalise(value);
  }
  if (source.nullable === true && typeof source.type === 'string') out.type = [source.type, 'null'];
  return out;
}

export function createValidators(spec: OpenApiDocument = loadSpec()): SpecValidators {
  const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: true, allowUnionTypes: true });
  addFormats(ajv);

  for (const [name, schema] of Object.entries(spec.components.schemas)) {
    ajv.addSchema(normalise(schema) as object, `#/components/schemas/${name}`);
  }

  const cache = new Map<string, ValidateFunction>();
  const lastErrors = new Map<string, string>();

  const resolve = (schemaName: string): unknown => {
    if (schemaName.startsWith('responses:')) {
      const name = schemaName.slice('responses:'.length);
      const schema = spec.components.responses?.[name]?.content?.['application/json']?.schema;
      if (!schema) throw new Error(`unknown response schema ${name}`);
      return normalise(schema);
    }
    if (!(schemaName in spec.components.schemas)) throw new Error(`unknown schema ${schemaName}`);
    return { $ref: `#/components/schemas/${schemaName}` };
  };

  return {
    has(schemaName) {
      try { resolve(schemaName); return true; } catch { return false; }
    },
    get(schemaName) {
      const cached = cache.get(schemaName);
      if (cached) return cached;
      const validate = ajv.compile(resolve(schemaName) as object);
      const wrapped: ValidateFunction = ((data: unknown) => {
        const valid = validate(data);
        wrapped.errors = validate.errors ?? null;
        if (!valid) lastErrors.set(schemaName, ajv.errorsText(validate.errors, { separator: '; ' }));
        return valid;
      }) as ValidateFunction;
      cache.set(schemaName, wrapped);
      return wrapped;
    },
    errorText: (schemaName) => lastErrors.get(schemaName) ?? '',
  };
}

/** Shared instance: compiling the 120-path document once is measurably cheaper than per request. */
let shared: SpecValidators | undefined;
export function validators(): SpecValidators {
  shared ??= createValidators();
  return shared;
}

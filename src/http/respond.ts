import type { Context } from 'hono';
import { validators } from './validate.ts';
import { errors } from './errors.ts';

/**
 * Single response exit (002 §1, hard rule 1). When response validation is on, every body is checked
 * against the vendored official schema before it leaves the process: a typo in a field name becomes
 * a loud 500 here rather than a silent contract break at the consumer.
 */

export interface RespondOptions {
  readonly validate: boolean;
  readonly onInvalid?: (schemaName: string, message: string, body: unknown) => void;
}

let options: RespondOptions = { validate: true };

export function configureRespond(next: RespondOptions): void {
  options = next;
}

export function assertValidBody(schemaName: string, body: unknown): void {
  if (!options.validate) return;
  const spec = validators();
  if (!spec.has(schemaName)) throw errors.internal(`unknown response schema ${schemaName}`);
  if (spec.get(schemaName)(body)) return;
  const message = spec.errorText(schemaName);
  options.onInvalid?.(schemaName, message, body);
  throw errors.internal(`response does not match ${schemaName}: ${message}`);
}

/**
 * The other half of the contract: every failure leaves through `GeneralError`, which the spec types
 * as `{ message, code, request_id? }`. `code` is a free string there, so this only guarantees the
 * envelope — but an error path that forgets a field, or a third-party error surfacing raw, would
 * otherwise ship silently. Returns the fallback error when the body does not fit.
 */
export function validatedErrorBody(body: unknown): unknown {
  if (!options.validate) return body;
  const spec = validators();
  if (spec.get('GeneralError')(body)) return body;
  const message = spec.errorText('GeneralError');
  options.onInvalid?.('GeneralError', message, body);
  return errors.internal().toBody();
}

export function respond<T>(c: Context, schemaName: string, body: T, status = 200): Response {
  assertValidBody(schemaName, body);
  return c.json(body as object, status as 200);
}

/**
 * For endpoints whose response is a bare array (e.g. `GET /api_keys`): the spec types the array
 * inline, so each element is validated against the item schema and the array is returned as-is.
 */
export function respondList<T>(c: Context, itemSchema: string, items: readonly T[], status = 200): Response {
  for (const item of items) assertValidBody(itemSchema, item);
  return c.json(items as unknown[] as object, status as 200);
}

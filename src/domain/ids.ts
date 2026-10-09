import { randomBytes, randomUUID } from 'node:crypto';

/**
 * Public IDs must satisfy the shapes every Neon client validates (002 §4):
 *   project  /^[a-z0-9-]{1,60}$/
 *   branch   /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
 *   endpoint /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/
 * Internal IDs are pageserver identifiers: 16 bytes rendered as 32 lowercase hex characters.
 */

const ADJECTIVES = [
  'ancient', 'bold', 'calm', 'damp', 'eager', 'floral', 'gentle', 'holy', 'icy', 'jolly',
  'kind', 'late', 'misty', 'noisy', 'odd', 'plain', 'quiet', 'raspy', 'shy', 'tiny',
  'urban', 'vast', 'wild', 'young', 'blue', 'green', 'crimson', 'silent', 'summer', 'winter',
] as const;

const NOUNS = [
  'art', 'bird', 'cloud', 'dawn', 'echo', 'field', 'glade', 'hill', 'iris', 'jade',
  'king', 'lake', 'moon', 'night', 'oak', 'pine', 'quill', 'river', 'star', 'tree',
  'union', 'voice', 'wave', 'yard', 'frog', 'brook', 'flower', 'glitter', 'sunset', 'water',
] as const;

const PROJECT_ID = /^[a-z0-9-]{1,60}$/;
const BRANCH_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ENDPOINT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const HEX_ID = /^[0-9a-f]{32}$/;

function pick<T>(items: readonly T[]): T {
  // rejection-free: the arrays are small, modulo bias is irrelevant for a display slug
  const index = randomBytes(2).readUInt16BE(0) % items.length;
  return items[index] as T;
}

function digits(count: number): string {
  let out = '';
  for (const byte of randomBytes(count)) out += String(byte % 10);
  return out;
}

/** `adj-noun-123456`, matching Neon's public project id shape. */
export function generateProjectId(): string {
  return `${pick(ADJECTIVES)}-${pick(NOUNS)}-${digits(6)}`;
}

/** `br-adj-noun-a1b2c3d4`. */
export function generateBranchId(): string {
  return `br-${pick(ADJECTIVES)}-${pick(NOUNS)}-${randomBytes(4).toString('hex')}`;
}

/** `ep-adj-noun-a1b2c3d4`. */
export function generateEndpointId(): string {
  return `ep-${pick(ADJECTIVES)}-${pick(NOUNS)}-${randomBytes(4).toString('hex')}`;
}

/** pageserver tenant / timeline id: 16 bytes as 32 hex characters. */
export function generateHexId(): string {
  return randomBytes(16).toString('hex');
}

/** Operation ids are UUIDs — the spec types Operation.id as `string:uuid`. */
export function generateOperationId(): string {
  return randomUUID();
}

export const idPatterns = {
  project: PROJECT_ID,
  branch: BRANCH_ID,
  endpoint: ENDPOINT_ID,
  hex: HEX_ID,
} as const;

export function isProjectId(value: string): boolean { return PROJECT_ID.test(value); }
export function isBranchId(value: string): boolean { return BRANCH_ID.test(value); }
export function isEndpointId(value: string): boolean { return ENDPOINT_ID.test(value); }
export function isHexId(value: string): boolean { return HEX_ID.test(value); }

#!/usr/bin/env node
/**
 * Mint an API key directly against the SQLite store. The plaintext is printed once and never stored.
 *
 *   node scripts/create-api-key.mjs "local dev"                 # personal key for CP_OWNER_ID
 *   node scripts/create-api-key.mjs "ci" --kind org --org org-x # organization key
 *
 * The control plane now also exposes `/api_keys` and `/organizations/{org_id}/api_keys` (design 004),
 * which is the preferred path; this script exists for first boot and for automation without HTTP.
 */
import { randomBytes, createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const args = process.argv.slice(2);
const name = args[0] ?? 'default';
const flag = (key, fallback) => {
  const index = args.indexOf(`--${key}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const path = process.env.CP_DB_PATH ?? './data/cp.sqlite';
const prefix = process.env.CP_KEY_PREFIX ?? 'napi_';
const owner = process.env.CP_OWNER_ID ?? '00000000-0000-0000-0000-000000000001';
const kind = flag('kind', 'user');
const orgId = flag('org', process.env.CP_ORG_ID ?? null);
if (kind !== 'user' && kind !== 'org') throw new Error('--kind must be user or org');
if (kind === 'org' && !orgId) throw new Error('--kind org requires --org <org_id> or CP_ORG_ID');

mkdirSync(dirname(path), { recursive: true });
const db = new Database(path);
db.pragma('journal_mode = WAL');

const key = `${prefix}${randomBytes(24).toString('base64url')}`;
const hash = createHash('sha256').update(key, 'utf8').digest('hex');
const info = db.prepare(
  `INSERT INTO api_keys (name, key_hash, created_by, created_at, kind, org_id)
   VALUES (?,?,?,?,?,?)`,
).run(name, hash, owner, new Date().toISOString(), kind, kind === 'org' ? orgId : null);
db.close();

console.log(`id:   ${info.lastInsertRowid}`);
console.log(`name: ${name}`);
console.log(`kind: ${kind}${kind === 'org' ? ` (${orgId})` : ''}`);
console.log(`key:  ${key}`);
console.log('\nStore it now: only the sha256 hash is kept.');
console.log(`Use it with:  curl -H "authorization: Bearer ${key}" http://localhost:8080/api/v2/projects`);

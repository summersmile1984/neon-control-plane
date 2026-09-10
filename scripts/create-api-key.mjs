#!/usr/bin/env node
/**
 * T-111: mint an API key. The plaintext is printed once and never stored.
 *
 *   node scripts/create-api-key.mjs "local dev"
 */
import { randomBytes, createHash, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const name = process.argv[2] ?? 'default';
const path = process.env.CP_DB_PATH ?? './data/cp.sqlite';
mkdirSync(dirname(path), { recursive: true });

const db = new Database(path);
db.pragma('journal_mode = WAL');
db.exec(`CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL, last_used_at TEXT)`);

const key = `neon_cp_${randomBytes(24).toString('base64url')}`;
const id = `key_${randomUUID().slice(0, 8)}`;
db.prepare('INSERT INTO api_keys (id, name, key_hash, created_at) VALUES (?,?,?,?)')
  .run(id, name, createHash('sha256').update(key, 'utf8').digest('hex'), new Date().toISOString());
db.close();

console.log(`id:   ${id}`);
console.log(`name: ${name}`);
console.log(`key:  ${key}`);
console.log('\nStore it now: only the sha256 hash is kept.');
console.log(`Use it with:  curl -H "authorization: Bearer ${key}" http://localhost:8080/api/v2/projects`);

import Database from 'better-sqlite3';
import { readFileSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * SQLite in WAL mode (002 §1). Single-process control plane, so synchronous statements plus
 * `db.transaction()` are enough; the reconciler claims work with a CAS update instead of a lock.
 */
export type Db = Database.Database;

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

export function openDatabase(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

export function migrate(db: Db): string[] {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const applied = new Set(
    db.prepare('SELECT name FROM schema_migrations').all().map((row) => (row as { name: string }).name),
  );
  const files = readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort();
  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    // PRAGMA statements inside a migration cannot run in a transaction; strip and apply them first.
    const pragmas = sql.match(/^PRAGMA[^;]+;/gm) ?? [];
    const body = sql.replace(/^PRAGMA[^;]+;/gm, '');
    for (const pragma of pragmas) db.exec(pragma);
    db.transaction(() => {
      db.exec(body);
      db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(file, new Date().toISOString());
    })();
    ran.push(file);
  }
  return ran;
}

/** ISO-8601 with milliseconds, the format every timestamp column and API field uses. */
export function now(): string {
  return new Date().toISOString();
}

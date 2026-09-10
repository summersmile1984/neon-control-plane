import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migrate } from '../../src/store/db.ts';

/**
 * Upgrading an existing 0001 database (design 004). `openDatabase` always runs every migration, so
 * this drives `migrate()` directly against a store that has only 0001 applied, with real legacy rows.
 */

const SQL_0001 = readFileSync(new URL('../../src/store/migrations/0001_init.sql', import.meta.url), 'utf8');

function legacyDatabase(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  db.exec(SQL_0001.replace(/^PRAGMA[^;]+;/gm, ''));
  db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run('0001_init.sql', new Date().toISOString());
  const ts = new Date().toISOString();
  db.prepare(
    `INSERT INTO projects (id, tenant_id, name, pg_version, region_id, platform_id, provisioner, store_passwords,
       history_retention_seconds, default_branch_id, settings_json, annotation_json, created_at, updated_at)
     VALUES ('legacy-proj','tenant-legacy','legacy',17,'local','local','k8s-pod',1,604800,NULL,'{}','{}',?,?)`,
  ).run(ts, ts);
  db.prepare("INSERT INTO api_keys (id, name, key_hash, created_at) VALUES ('key_legacy','old','deadbeef',?)").run(ts);
  return db;
}

describe('migration 0001 -> 0002', () => {
  it('applies only 0002 and preserves legacy projects', () => {
    const db = legacyDatabase();
    const ran = migrate(db);
    expect(ran).toEqual(['0002_identity_keys.sql']);

    const columns = (db.prepare('PRAGMA table_info(projects)').all() as Array<{ name: string }>).map((row) => row.name);
    expect(columns).toContain('org_id');

    const project = db.prepare("SELECT org_id FROM projects WHERE id = 'legacy-proj'").get() as { org_id: string | null };
    expect(project.org_id).toBeNull();
  });

  it('rebuilds api_keys and adds the identity tables', () => {
    const db = legacyDatabase();
    migrate(db);

    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((row) => row.name);
    for (const table of ['api_keys', 'users', 'organizations', 'members', 'sessions']) expect(tables).toContain(table);

    // The rebuilt table is empty; old string-id keys are intentionally not carried over.
    expect((db.prepare('SELECT COUNT(*) AS total FROM api_keys').get() as { total: number }).total).toBe(0);
    const apiKeyColumns = (db.prepare('PRAGMA table_info(api_keys)').all() as Array<{ name: string }>).map((row) => row.name);
    for (const column of ['id', 'key_hash', 'created_by', 'last_used_from_addr', 'revoked_at', 'kind', 'org_id', 'project_id']) {
      expect(apiKeyColumns).toContain(column);
    }
  });
});

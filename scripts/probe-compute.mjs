#!/usr/bin/env node
/**
 * T-004 probe: start a real compute-node against the compose storage layer and answer the open
 * questions in 002 §14 (items 2, 3, 6, 8).
 *
 *   node scripts/probe-compute.mjs [--variant top|guc|both] [--keep]
 *
 * Requires `pnpm compose:up` and the `neondatabase/compute-node-v17` image.
 */
import { execFileSync, execSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { randomBytes, createHash, createHmac, pbkdf2Sync } from 'node:crypto';
import { join, resolve } from 'node:path';
import { createComputeSigner } from '../src/domain/compute-auth.ts';

const signer = createComputeSigner('probe-key');
const authHeaders = () => ({ authorization: 'Bearer ' + signer.token(containerName) });

const args = process.argv.slice(2);
const variant = args.includes('--variant') ? args[args.indexOf('--variant') + 1] : 'both';
const keep = args.includes('--keep');

const PAGESERVER = 'http://127.0.0.1:9898';
const TAG = process.env.NEON_TAG ?? 'latest';
const IMAGE = `docker.io/neondatabase/compute-node-v17:${TAG}`;
const NETWORK = 'neon-cp';
const PG_VERSION = 17;
const hex = () => randomBytes(16).toString('hex');

const tenantId = hex();
const timelineId = hex();
const containerName = `cp-probe-${randomBytes(4).toString('hex')}`;
const workdir = resolve(`./data/probe/${containerName}`);
const hostPgPort = 55599;
const hostHttpPort = 55699;

function scram(password, iterations = 4096, salt = randomBytes(16)) {
  const salted = pbkdf2Sync(Buffer.from(password, 'utf8'), salt, iterations, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();
  return ['SCRAM-SHA-256$', iterations, ':', salt.toString('base64'), '$', storedKey.toString('base64'), ':', serverKey.toString('base64')].join('');
}

async function api(method, path, body) {
  const response = await fetch(`${PAGESERVER}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : undefined;
}

/** 23 settings from the official docker-compose template, plus the storage GUCs for the `guc` variants. */
function settings({ withGucs }) {
  const base = [
    { name: 'fsync', value: 'off', vartype: 'bool' },
    { name: 'wal_level', value: 'logical', vartype: 'enum' },
    { name: 'wal_log_hints', value: 'on', vartype: 'bool' },
    { name: 'log_connections', value: 'on', vartype: 'bool' },
    { name: 'port', value: '55433', vartype: 'integer' },
    { name: 'shared_buffers', value: '1MB', vartype: 'string' },
    { name: 'max_connections', value: '100', vartype: 'integer' },
    { name: 'listen_addresses', value: '0.0.0.0', vartype: 'string' },
    { name: 'max_wal_senders', value: '10', vartype: 'integer' },
    { name: 'max_replication_slots', value: '10', vartype: 'integer' },
    { name: 'wal_sender_timeout', value: '5s', vartype: 'string' },
    { name: 'password_encryption', value: 'scram-sha-256', vartype: 'enum' },
    { name: 'restart_after_crash', value: 'off', vartype: 'bool' },
    { name: 'synchronous_standby_names', value: 'walproposer', vartype: 'string' },
    { name: 'shared_preload_libraries', value: 'neon', vartype: 'string' },
  ];
  if (!withGucs) return base;
  return [
    ...base,
    { name: 'neon.safekeepers', value: 'safekeeper1:5454', vartype: 'string' },
    { name: 'neon.timeline_id', value: timelineId, vartype: 'string' },
    { name: 'neon.tenant_id', value: tenantId, vartype: 'string' },
    { name: 'neon.pageserver_connstring', value: 'host=pageserver port=6400', vartype: 'string' },
    { name: 'max_replication_write_lag', value: '500MB', vartype: 'string' },
    { name: 'max_replication_flush_lag', value: '10GB', vartype: 'string' },
  ];
}

function buildSpec({ withTopLevel, withGucs, roles, databases, deltaOperations }) {
  const spec = {
    format_version: 1,
    timestamp: new Date().toISOString(),
    operation_uuid: crypto.randomUUID(),
    suspend_timeout_seconds: -1,
    mode: 'Primary',
    cluster: {
      cluster_id: 'probe',
      name: 'probe',
      state: 'restarted',
      roles,
      databases,
      settings: settings({ withGucs }),
    },
    delta_operations: deltaOperations ?? [],
    skip_pg_catalog_updates: false,
  };
  if (withTopLevel) {
    spec.tenant_id = tenantId;
    spec.timeline_id = timelineId;
    spec.pageserver_connstring = 'host=pageserver port=6400';
    spec.safekeeper_connstrings = ['safekeeper1:5454'];
  }
  // compute_ctl refuses to parse a config whose compute_ctl_config lacks jwks (実測 2026-09-07)
  return { spec, compute_ctl_config: { jwks: signer.jwks() } };
}

const cloudAdmin = { name: 'cloud_admin', encrypted_password: scram('cloud-admin-probe'), options: null };
const appRole = { name: 'app_owner', encrypted_password: scram('app-probe-pw'), options: null };
const extraRole = { name: 'to_be_dropped', encrypted_password: scram('drop-me'), options: null };

function writeConfig(envelope) {
  mkdirSync(join(workdir, 'spec'), { recursive: true });
  mkdirSync(join(workdir, 'pgdata'), { recursive: true });
  writeFileSync(join(workdir, 'spec/config.json'), JSON.stringify(envelope, null, 2));
}

function docker(args, options = {}) {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: options.stdio ?? 'pipe' });
}

async function waitForComputeStatus(target, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let last = 'unknown';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${hostHttpPort}/status`, { headers: authHeaders() });
      if (response.ok) {
        const body = await response.json();
        last = body.status ?? JSON.stringify(body).slice(0, 80);
        if (last === target) return body;
        if (last === 'failed') return body;
      }
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return { status: `timeout(last=${last})` };
}

function psql(sql, { user = 'cloud_admin', db = 'postgres' } = {}) {
  try {
    return docker(['exec', containerName, 'psql', '-h', '127.0.0.1', '-p', '55433', '-U', user, '-d', db, '-tAc', sql]).trim();
  } catch (error) {
    return `ERROR: ${String(error.stderr ?? error.message).slice(0, 200)}`;
  }
}

async function main() {
  console.log(`# T-004 compute probe  tenant=${tenantId} timeline=${timelineId} variant=${variant}`);

  await api('PUT', `/v1/tenant/${tenantId}/location_config`, { mode: 'AttachedSingle', generation: 1, tenant_conf: {} });
  await api('POST', `/v1/tenant/${tenantId}/timeline/`, { new_timeline_id: timelineId, pg_version: PG_VERSION });
  console.log('storage: tenant attached, timeline created');

  const variants = variant === 'both'
    ? [{ withTopLevel: true, withGucs: true, label: 'both' }]
    : variant === 'top'
      ? [{ withTopLevel: true, withGucs: false, label: 'top-level fields only' }]
      : [{ withTopLevel: false, withGucs: true, label: 'GUCs only' }];

  for (const shape of variants) {
    console.log(`\n## spec shape: ${shape.label}`);
    writeConfig(buildSpec({
      withTopLevel: shape.withTopLevel,
      withGucs: shape.withGucs,
      roles: [cloudAdmin, appRole, extraRole],
      databases: [{ name: 'appdb', owner: 'app_owner', options: null }],
    }));

    docker(['rm', '-f', containerName]).catch?.(() => {});
    try { docker(['rm', '-f', containerName]); } catch { /* not running */ }

    docker([
      'run', '-d', '--name', containerName, '--network', NETWORK,
      '-p', `${hostPgPort}:55433`, '-p', `${hostHttpPort}:3080`,
      '-v', `${join(workdir, 'spec')}:/spec:ro`,
      '--entrypoint', '/usr/local/bin/compute_ctl',
      IMAGE,
      '--pgdata', '/var/db/postgres/compute',
      '-C', 'postgresql://cloud_admin@localhost:55433/postgres',
      '-b', '/usr/local/bin/postgres',
      '--compute-id', containerName,
      '--config', '/spec/config.json',
      '--dev',
    ]);

    const status = await waitForComputeStatus('running');
    console.log('compute_ctl status:', JSON.stringify(status).slice(0, 300));

    if (status.status === 'running') {
      console.log('psql select 1        :', psql('select 1'));
      console.log('psql current roles   :', psql("select rolname from pg_roles where rolname not like 'pg_%' order by 1"));
      console.log('psql databases       :', psql("select datname from pg_database where datname not in ('template0','template1') order by 1"));
      console.log('psql app_owner login :', psql('select current_user', { user: 'app_owner', db: 'appdb' }));

      // 002 §14 item 3: does a spec without the role drop it, or is delta_operations required?
      const withoutRole = buildSpec({
        withTopLevel: shape.withTopLevel, withGucs: shape.withGucs,
        roles: [cloudAdmin, appRole], databases: [{ name: 'appdb', owner: 'app_owner', options: null }],
      });
      const configure = await fetch(`http://127.0.0.1:${hostHttpPort}/configure`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...authHeaders() }, body: JSON.stringify(withoutRole),
      });
      console.log('POST /configure (role removed from spec):', configure.status, (await configure.text()).slice(0, 200));
      await new Promise((r) => setTimeout(r, 3000));
      console.log('roles after implicit removal:', psql("select rolname from pg_roles where rolname not like 'pg_%' order by 1"));

      const withDelta = buildSpec({
        withTopLevel: shape.withTopLevel, withGucs: shape.withGucs,
        roles: [cloudAdmin, appRole], databases: [{ name: 'appdb', owner: 'app_owner', options: null }],
        deltaOperations: [{ action: 'delete_role', name: 'to_be_dropped' }],
      });
      const configure2 = await fetch(`http://127.0.0.1:${hostHttpPort}/configure`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...authHeaders() }, body: JSON.stringify(withDelta),
      });
      console.log('POST /configure (delta delete_role):', configure2.status, (await configure2.text()).slice(0, 200));
      await new Promise((r) => setTimeout(r, 3000));
      console.log('roles after delta_operations:', psql("select rolname from pg_roles where rolname not like 'pg_%' order by 1"));
      console.log('dbs_and_roles endpoint:', await fetch(`http://127.0.0.1:${hostHttpPort}/dbs_and_roles`, { headers: authHeaders() }).then((r) => r.text()).then((t) => t.slice(0, 300)).catch((e) => String(e)));
    } else {
      console.log('--- compute_ctl logs (tail) ---');
      try { console.log(docker(['logs', '--tail', '40', containerName])); } catch (error) { console.log(String(error.message).slice(0, 300)); }
    }

    if (!keep) { try { docker(['rm', '-f', containerName]); } catch { /* already gone */ } }
  }

  if (!keep) {
    await api('DELETE', `/v1/tenant/${tenantId}/timeline/${timelineId}`).catch(() => undefined);
    await api('DELETE', `/v1/tenant/${tenantId}`).catch(() => undefined);
    rmSync(workdir, { recursive: true, force: true });
  }
  console.log('\ndone');
}

main().catch((error) => {
  console.error('probe failed:', error);
  try { execSync(`docker rm -f ${containerName}`, { stdio: 'ignore' }); } catch { /* ignore */ }
  process.exit(1);
});

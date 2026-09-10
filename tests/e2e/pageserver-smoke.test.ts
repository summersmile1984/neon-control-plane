import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PageserverError, createPageserverClient } from '../../src/adapters/pageserver.ts';
import { generateHexId } from '../../src/domain/ids.ts';

/**
 * T-003: drive a real pageserver through the adapter and record the facts 002 §14 asks for.
 * Requires `pnpm compose:up`. Skipped (not failed) when the stack is not running, so that
 * `pnpm test` stays usable on a machine without Docker.
 */
const baseUrl = process.env.CP_PAGESERVER_URL ?? 'http://127.0.0.1:9898';
const client = createPageserverClient({ baseUrl, timeoutMs: 30_000 });

const PG_VERSION = Number(process.env.PG_VERSION ?? 17);
const tenantId = generateHexId();
const mainTimeline = generateHexId();
const branchTimeline = generateHexId();

let reachable = false;

beforeAll(async () => {
  try {
    await client.status();
    reachable = true;
  } catch {
    reachable = false;
  }
});

afterAll(async () => {
  if (!reachable) return;
  for (const timeline of [branchTimeline, mainTimeline]) {
    await client.deleteTimeline(tenantId, timeline).catch(() => undefined);
  }
  await client.deleteTenant(tenantId).catch(() => undefined);
});

beforeEach((context) => {
  if (!reachable) context.skip(`pageserver at ${baseUrl} is not reachable; run pnpm compose:up`);
});

describe.skipIf(!process.env.CI && false)('pageserver adapter against a live stack', () => {
  it('reports its identity', async () => {
    if (!reachable) return expect(reachable, `pageserver at ${baseUrl} is not reachable; run pnpm compose:up`).toBe(false);
    const status = await client.status();
    expect(status).toHaveProperty('id');
  });

  it('attaches a tenant with location_config (no storage controller)', async () => {
    if (!reachable) return;
    await client.locationConfig(tenantId, {
      mode: 'AttachedSingle',
      generation: 1,
      // pitr_interval is the retention window behind branch-by-timestamp (002 §5.2)
      tenant_conf: { pitr_interval: '7days' },
    });
    const tenants = await client.listTenants();
    expect(tenants.map((tenant) => tenant.id)).toContain(tenantId);
  });

  it('creates the main timeline and reports an LSN', async () => {
    if (!reachable) return;
    const created = await client.createTimeline(tenantId, { new_timeline_id: mainTimeline, pg_version: PG_VERSION });
    expect(created.timeline_id).toBe(mainTimeline);

    const detail = await client.getTimeline(tenantId, mainTimeline);
    expect(detail.timeline_id).toBe(mainTimeline);
    expect(typeof detail.last_record_lsn).toBe('string');
    expect(detail.last_record_lsn).toMatch(/^[0-9A-F]+\/[0-9A-F]+$/i);
  });

  it('branches a timeline from the parent tip', async () => {
    if (!reachable) return;
    const parent = await client.getTimeline(tenantId, mainTimeline);
    const branched = await client.createTimeline(tenantId, {
      new_timeline_id: branchTimeline,
      ancestor_timeline_id: mainTimeline,
      ancestor_start_lsn: parent.last_record_lsn as string,
    });
    expect(branched.timeline_id).toBe(branchTimeline);
    expect(branched.ancestor_timeline_id).toBe(mainTimeline);

    const timelines = await client.listTimelines(tenantId);
    expect(timelines.map((timeline) => timeline.timeline_id).sort()).toEqual([mainTimeline, branchTimeline].sort());
  });

  it('answers get_lsn_by_timestamp for now and for a timestamp before the history', async () => {
    if (!reachable) return;
    const now = await client.getLsnByTimestamp(tenantId, mainTimeline, new Date().toISOString());
    // Record the actual shape: 002 §14 item 4 asks whether `kind` distinguishes an exact hit.
    expect(now).toBeTypeOf('object');

    const ancient = await client.getLsnByTimestamp(tenantId, mainTimeline, '2000-01-01T00:00:00Z');
    expect(ancient).toBeTypeOf('object');
    // Neither call may throw: an out-of-range timestamp is answered, not rejected.
    expect(JSON.stringify({ now, ancient }).length).toBeGreaterThan(2);
  });

  it('classifies a missing tenant as not_found rather than a generic failure', async () => {
    if (!reachable) return;
    const missing = generateHexId();
    await expect(client.listTimelines(missing)).rejects.toBeInstanceOf(PageserverError);
    await client.listTimelines(missing).catch((error: PageserverError) => {
      expect(error.kind).toBe('not_found');
      expect(error.status).toBe(404);
    });
  });

  it('deletes a timeline and then the tenant', async () => {
    if (!reachable) return;
    await client.deleteTimeline(tenantId, branchTimeline);
    // pageserver deletes asynchronously; the timeline disappears from the list once it completes.
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const timelines = await client.listTimelines(tenantId);
      if (!timelines.some((timeline) => timeline.timeline_id === branchTimeline)) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    const remaining = await client.listTimelines(tenantId);
    expect(remaining.map((timeline) => timeline.timeline_id)).not.toContain(branchTimeline);
  });
});

import { createPageserverClient } from '../src/adapters/pageserver.ts';
import { generateHexId } from '../src/domain/ids.ts';
const c = createPageserverClient({ baseUrl: 'http://127.0.0.1:9898' });
const tenant = generateHexId(); const main = generateHexId(); const child = generateHexId();
await c.locationConfig(tenant, { mode: 'AttachedSingle', generation: 1, tenant_conf: { pitr_interval: '7days' } });
const created = await c.createTimeline(tenant, { new_timeline_id: main, pg_version: 17 });
console.log('createTimeline keys:', Object.keys(created).join(','));
console.log('createTimeline:', JSON.stringify(created).slice(0, 700));
const now = await c.getLsnByTimestamp(tenant, main, new Date().toISOString());
console.log('lsn_by_timestamp(now):', JSON.stringify(now));
const old = await c.getLsnByTimestamp(tenant, main, '2000-01-01T00:00:00Z');
console.log('lsn_by_timestamp(2000):', JSON.stringify(old));
const future = await c.getLsnByTimestamp(tenant, main, '2099-01-01T00:00:00Z');
console.log('lsn_by_timestamp(2099):', JSON.stringify(future));
const branched = await c.createTimeline(tenant, { new_timeline_id: child, ancestor_timeline_id: main, ancestor_start_lsn: created.last_record_lsn });
console.log('branch ancestor fields:', JSON.stringify({ a: branched.ancestor_timeline_id, l: branched.ancestor_lsn }));
try { await c.createTimeline(tenant, { new_timeline_id: main, pg_version: 17 }); console.log('duplicate timeline: accepted (idempotent)'); }
catch (e) { console.log('duplicate timeline:', e.kind, e.status, String(e.message).slice(0,120)); }
const detail = await c.getTimeline(tenant, main);
console.log('timeline detail keys:', Object.keys(detail).join(','));
await c.deleteTimeline(tenant, child).catch(()=>{}); await c.deleteTimeline(tenant, main).catch(()=>{}); await c.deleteTenant(tenant).catch(()=>{});

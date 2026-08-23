const { db, jobs, credentials } = require('/app/packages/db/dist/index.js');
const { Queue } = require('bullmq');
const Redis = require('ioredis');
const { count, eq, sql } = require('drizzle-orm');

const REDIS_URL = process.env.REDIS_URL || 'redis://med-re-1v5w985hl5btz.4iazwm.0001.aps1.cache.amazonaws.com:6379';
const redis = new Redis(REDIS_URL);

async function run() {
  // 1. Job status breakdown
  const statusBreakdown = await db.select({ status: jobs.status, c: count() }).from(jobs).groupBy(jobs.status);
  console.log('\n=== Job Status Breakdown ===');
  let total = 0;
  for (const row of statusBreakdown) {
    console.log(`  ${row.status}: ${row.c}`);
    total += parseInt(row.c);
  }
  console.log(`  TOTAL: ${total}`);

  // 2. Credential status
  const credStatus = await db.select().from(credentials);
  console.log('\n=== Credential Status ===');
  for (const c of credStatus) {
    console.log(`  [${c.platform}] ${c.id}: status=${c.status}, failures=${c.consecutiveFailures}, blocks=${c.blockCount}, leaseId=${c.leaseId ? 'ACTIVE' : 'none'}`);
  }

  // 3. BullMQ queue depths
  console.log('\n=== Queue Depths ===');
  for (const qName of ['download-reddit', 'download-twitter', 'download-instagram', 'download-tiktok']) {
    const q = new Queue(qName, { connection: redis });
    const waiting = await q.getWaitingCount();
    const active = await q.getActiveCount();
    const delayed = await q.getDelayedCount();
    const failed = await q.getFailedCount();
    const completed = await q.getCompletedCount();
    console.log(`  ${qName}: waiting=${waiting} active=${active} delayed=${delayed} failed=${failed} completed=${completed}`);
  }

  // 4. Circuit breaker state
  console.log('\n=== Circuit Breaker State ===');
  const cbKeys = await redis.keys('cb:*:state');
  for (const key of cbKeys) {
    const val = await redis.get(key);
    console.log(`  ${key}: ${val}`);
  }
  
  // 5. Redis errors (admission controller counters)
  const acquisitions = await redis.get('metric:platform_acquisitions');
  console.log(`\n=== Metrics ===`);
  console.log(`  Total platform acquisitions: ${acquisitions || 0}`);

  await redis.quit();
  process.exit(0);
}

run().catch(e => { console.error(e); process.exit(1); });

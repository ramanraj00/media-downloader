const { db, jobs, credentials } = require('/app/packages/db/dist/index.js');
const { Queue } = require('bullmq');
const Redis = require('ioredis');
const crypto = require('crypto');
const { eq, sql } = require('drizzle-orm');

const REDIS_URL = process.env.REDIS_URL || 'redis://med-re-1v5w985hl5btz.4iazwm.0001.aps1.cache.amazonaws.com:6379';
const redis = new Redis(REDIS_URL);

async function run() {
  const count = parseInt(process.argv[2] || '10', 10);
  console.log(`=== Phase 15A.3 Load Test: ${count} jobs ===`);

  // 1. Reset circuit breakers
  const cbKeys = await redis.keys('cb:*');
  if (cbKeys.length > 0) {
    await redis.del(...cbKeys);
    console.log(`[RESET] Cleared ${cbKeys.length} circuit breaker keys`);
  }

  // 2. Reset credential pool hints in Redis
  const cpKeys = await redis.keys('credential_pool:*');
  if (cpKeys.length > 0) {
    await redis.del(...cpKeys);
    console.log(`[RESET] Cleared ${cpKeys.length} credential pool hint keys`);
  }

  // 3. Re-sync reddit credential to Redis
  const redditCreds = await db.select().from(credentials).where(eq(credentials.platform, 'reddit'));
  if (redditCreds.length > 0) {
    // Reset status to AVAILABLE
    await db.update(credentials).set({ status: 'AVAILABLE', leaseId: null, leaseUntil: null, consecutiveFailures: 0 }).where(eq(credentials.platform, 'reddit'));
    await redis.rpush('credential_pool:reddit:list', ...redditCreds.map(c => c.id));
    console.log(`[RESET] Synced ${redditCreds.length} reddit credential(s) to Redis`);
  }

  // 4. Delete ALL old jobs from DB
  const deleted = await db.delete(jobs).returning({ id: jobs.id });
  console.log(`[RESET] Deleted ${deleted.length} old jobs from database`);

  // 5. Clear old BullMQ queues
  for (const qName of ['download-reddit', 'download-twitter', 'download-instagram', 'download-tiktok']) {
    const q = new Queue(qName, { connection: redis });
    await q.obliterate({ force: true });
    console.log(`[RESET] Obliterated queue: ${qName}`);
  }

  // 6. Reset metrics
  await redis.del('metric:platform_acquisitions');

  // 7. Seed N jobs
  const url = 'https://www.reddit.com/r/MadeMeSmile/comments/6t7wi5/wait_for_it/';
  const platform = 'reddit';
  const q = new Queue(`download-${platform}`, { connection: redis });
  const startTime = Date.now();

  for (let i = 0; i < count; i++) {
    const jobId = crypto.randomUUID();
    const urlHash = crypto.createHash('sha256').update(url + jobId).digest('hex');
    
    await db.insert(jobs).values({
      id: jobId,
      url,
      normalizedUrl: url,
      urlHash,
      platform,
      userId: 1,
      chatId: '999',
      status: 'pending',
      createdAt: new Date(),
      updatedAt: new Date()
    });

    await q.add('download', { jobId, url, urlHash, platform }, { jobId, removeOnComplete: true });
  }

  const seedTime = Date.now() - startTime;
  console.log(`[SEED] Enqueued ${count} jobs in ${seedTime}ms`);
  console.log(`[SEED] Start timestamp: ${new Date().toISOString()}`);

  await redis.quit();
  process.exit(0);
}

run().catch(e => { console.error(e); process.exit(1); });

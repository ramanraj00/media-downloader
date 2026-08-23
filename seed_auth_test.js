const { db, jobs, users } = require('/app/packages/db/dist/index.js');
const { Queue } = require('bullmq');
const Redis = require('ioredis');
const crypto = require('crypto');
async function run() {
  const connection = new Redis('redis://med-re-1v5w985hl5btz.4iazwm.0001.aps1.cache.amazonaws.com:6379');
  const qTwitter = new Queue('download-twitter', { connection });
  const url = 'https://x.com/SpaceX/status/auth_test';
  const platform = 'twitter';
  const jobId = crypto.randomUUID();
  const urlHash = crypto.createHash('sha256').update(url).digest('hex');
  await db.insert(jobs).values({ id: jobId, url, normalizedUrl: url, urlHash, platform, userId: 1, chatId: '999', status: 'pending', createdAt: new Date(), updatedAt: new Date() });
  await qTwitter.add('download', { jobId, url, urlHash, platform }, { jobId, removeOnComplete: true });
  console.log(`Enqueued auth_test -> ${jobId}`);
  await connection.quit();
  process.exit(0);
}
run().catch(console.error);

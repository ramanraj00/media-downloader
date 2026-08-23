const { db, jobs, users } = require('/app/packages/db/dist/index.js');
const { Queue } = require('bullmq');
const Redis = require('ioredis');
const crypto = require('crypto');

const REDIS_URL = process.env.REDIS_URL || 'redis://med-re-1v5w985hl5btz.4iazwm.0001.aps1.cache.amazonaws.com:6379';
const connection = new Redis(REDIS_URL);
const url = 'https://www.reddit.com/r/MadeMeSmile/comments/6t7wi5/wait_for_it/';
const platform = 'reddit';

async function seed(count) {
  let enqueued = 0;
  const q = new Queue(`download-${platform}`, { connection });
  
  for (let i = 0; i < count; i++) {
    const jobId = crypto.randomUUID();
    const urlHash = crypto.createHash('sha256').update(url + jobId).digest('hex');
    
    await db.insert(jobs).values({
      id: jobId,
      url: url,
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
    enqueued++;
  }
  
  console.log(`Successfully enqueued ${enqueued} jobs.`);
  await connection.quit();
  process.exit(0);
}

const args = process.argv.slice(2);
const count = parseInt(args[0], 10) || 10;
seed(count).catch(console.error);

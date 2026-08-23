const { db, jobs, credentials } = require('@media-downloader/db');
const crypto = require('crypto');
const { Queue } = require('bullmq');

async function seed() {
  const url = 'https://www.tiktok.com/@mrbeast/video/7279140417936903466';
  
  // Seed proxy
  const proxyId = crypto.randomUUID();
  await db.insert(credentials).values({
    id: proxyId,
    platform: 'tiktok',
    type: 'EGRESS',
    isAvailable: true,
    encryptedData: 'http://47.81.56.193:8888',
    lastUsedAt: null,
    cooldownUntil: null
  });

  console.log(`Seeded proxy credential: ${proxyId}`);
  
  // Enqueue job
  const jobId = crypto.randomUUID();
  const urlHash = crypto.createHash('sha256').update(url).digest('hex');
  
  await db.insert(jobs).values({
    id: jobId,
    platform: 'tiktok',
    url: url,
    urlHash: urlHash,
    status: 'QUEUED'
  });
  
  const q = new Queue('download-tiktok', { connection: { host: '127.0.0.1', port: 6379 } });
  await q.add('download', { jobId, url, platform: 'tiktok' }, { jobId });
  console.log(`Enqueued job: ${jobId}`);
  
  process.exit(0);
}

seed().catch(console.error);

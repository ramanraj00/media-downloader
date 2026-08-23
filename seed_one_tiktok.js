process.env.DATABASE_URL = "postgresql://postgres:K^5qO=Lw-eok^NZ2b-MJ6w0moFa=CN@mediadownloaderinfrastructurestac-databaseb269d8bb-odpvv1nzujn6.c3aok80aqorg.ap-south-1.rds.amazonaws.com:5432/postgres?sslmode=require";
const { db, jobs, credentials, users } = require('@media-downloader/db');
const { Queue } = require('bullmq');
const Redis = require('ioredis');
const crypto = require('crypto');
const { eq } = require('drizzle-orm');

async function run() {
  const connection = new Redis('redis://med-re-1v5w985hl5btz.4iazwm.0001.aps1.cache.amazonaws.com:6379');
  const qTiktok = new Queue('download-tiktok', { connection });
  
  const url = 'https://www.tiktok.com/@mrbeast/video/7279140417936903466?t=' + Date.now();
  const platform = 'tiktok';

  // Insert our proxy with platform 'egress'
  await db.delete(credentials).where(eq(credentials.platform, 'egress'));
  const proxyId = crypto.randomUUID();
  await db.insert(credentials).values({
    id: proxyId,
    platform: 'egress',
    encryptedData: 'http://47.81.56.193:8888',
    status: 'AVAILABLE'
  });

  // Push directly to Redis so we don't have to restart the worker or rely on syncToRedis('egress')
  await connection.del('credential_pool:egress:list');
  await connection.rpush('credential_pool:egress:list', proxyId);

  const jobId = crypto.randomUUID();
  const urlHash = crypto.createHash('sha256').update(url).digest('hex'); 
  
  await db.insert(jobs).values({
    id: jobId,
    url: url,
    normalizedUrl: url,
    urlHash: urlHash,
    platform: platform,
    userId: 1,
    chatId: '999',
    status: 'pending',
    createdAt: new Date(),
    updatedAt: new Date()
  });

  await qTiktok.add('download', { jobId, url, urlHash, platform }, { jobId, removeOnComplete: true });
  console.log(`Enqueued ${platform} ${url} -> ${jobId}`);
  
  await connection.quit();
  process.exit(0);
}

run().catch(console.error);

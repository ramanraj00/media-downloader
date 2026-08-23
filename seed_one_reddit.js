process.env.DATABASE_URL = "postgresql://postgres:K^5qO=Lw-eok^NZ2b-MJ6w0moFa=CN@mediadownloaderinfrastructurestac-databaseb269d8bb-odpvv1nzujn6.c3aok80aqorg.ap-south-1.rds.amazonaws.com:5432/postgres?sslmode=require";
const { db, jobs, users } = require('@media-downloader/db');
const { Queue } = require('bullmq');
const Redis = require('ioredis');
const crypto = require('crypto');

async function run() {
  const connection = new Redis('redis://med-re-1v5w985hl5btz.4iazwm.0001.aps1.cache.amazonaws.com:6379');
  const qReddit = new Queue('download-reddit', { connection });
  
  const url = 'https://www.reddit.com/r/MadeMeSmile/comments/6t7wi5/wait_for_it/?t=' + Date.now();
  const platform = 'reddit';

  try {
    await db.insert(users).values({ id: 1, telegramId: '999', creditBalance: 100 }).onConflictDoNothing();
  } catch(e) {}

  const jobId = crypto.randomUUID();
  const urlHash = crypto.createHash('sha256').update(url).digest('hex'); // strictly 64 chars!
  
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

  await qReddit.add('download', { jobId, url, urlHash, platform }, { jobId, removeOnComplete: true });
  console.log(`Enqueued ${platform} ${url} -> ${jobId}`);
  
  await connection.quit();
  process.exit(0);
}

run().catch(console.error);

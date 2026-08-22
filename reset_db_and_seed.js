process.env.DATABASE_URL = "postgresql://postgres:K^5qO=Lw-eok^NZ2b-MJ6w0moFa=CN@mediadownloaderinfrastructurestac-databaseb269d8bb-odpvv1nzujn6.c3aok80aqorg.ap-south-1.rds.amazonaws.com:5432/postgres?sslmode=require";
const { db, jobs, outboxEvents, users } = require('@media-downloader/db');
const { Queue } = require('bullmq');
const Redis = require('ioredis');
const crypto = require('crypto');

async function run() {
  await db.delete(jobs);
  await db.delete(outboxEvents);
  console.log('Database cleared');
  
  const connection = new Redis('redis://med-re-1v5w985hl5btz.4iazwm.0001.aps1.cache.amazonaws.com:6379');
  
  await connection.flushall();
  console.log('Redis cleared');

  const qReddit = new Queue('download-reddit', { connection });
  const qTiktok = new Queue('download-tiktok', { connection });
  
  const seedJobs = [
    { queue: qReddit, url: 'https://www.reddit.com/r/videos/comments/6rrwyj/that_small_heart_attack/', platform: 'reddit' },
    { queue: qReddit, url: 'https://www.reddit.com/r/aww/comments/90bu6w/heat_index_was_110_degrees_so_we_offered_him_a/', platform: 'reddit' },
    { queue: qReddit, url: 'https://www.reddit.com/r/Unexpected/comments/1cl9h0u/the_insurance_claim_will_be_interesting/', platform: 'reddit' },
    { queue: qReddit, url: 'https://www.reddit.com/r/soccer/comments/1cxwzso/tottenham_1_0_newcastle_united_james_maddison_31/', platform: 'reddit' },
    { queue: qReddit, url: 'https://www.reddit.com/r/MadeMeSmile/comments/6t7wi5/wait_for_it/', platform: 'reddit' },
    { queue: qTiktok, url: 'https://www.tiktok.com/@tiktok/video/7106594312292453678', platform: 'tiktok' },
    { queue: qTiktok, url: 'https://www.tiktok.com/@mrbeast/video/7279140417936903466', platform: 'tiktok' },
    { queue: qTiktok, url: 'https://www.tiktok.com/@bellapoarch/video/6862153058223197445', platform: 'tiktok' },
    { queue: qTiktok, url: 'https://www.tiktok.com/@khaby.lame/video/7183607738206260486', platform: 'tiktok' },
    { queue: qTiktok, url: 'https://www.tiktok.com/@zachking/video/6768504823336803589', platform: 'tiktok' }
  ];

  try {
    await db.insert(users).values({ id: 1, telegramId: '999', creditBalance: 100 }).onConflictDoNothing();
  } catch(e) {}

  for (const j of seedJobs) {
    const jobId = crypto.randomUUID();
    
    await db.insert(jobs).values({
      id: jobId,
      url: j.url,
      normalizedUrl: j.url,
      urlHash: crypto.createHash('sha256').update(j.url).digest('hex'),
      platform: j.platform,
      userId: 1,
      chatId: '999',
      status: 'pending',
      createdAt: new Date(),
      updatedAt: new Date()
    });

    await j.queue.add('download', { jobId, url: j.url, urlHash: crypto.createHash('sha256').update(j.url).digest('hex'), platform: j.platform }, { jobId, removeOnComplete: true });
    console.log(`Enqueued ${j.platform} ${j.url} -> ${jobId}`);
  }
  
  await connection.quit();
  process.exit(0);
}

run().catch(console.error);

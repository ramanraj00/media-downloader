const { Queue } = require('bullmq');
const Redis = require('ioredis');
const crypto = require('crypto');

async function run() {
  const REDIS_URL = 'redis://med-re-1v5w985hl5btz.4iazwm.0001.aps1.cache.amazonaws.com:6379';
  const connection = new Redis(REDIS_URL);
  
  await connection.flushall();
  console.log('Redis cleared');

  const qReddit = new Queue('download:reddit', { connection });
  const qTiktok = new Queue('download:tiktok', { connection });
  
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

  for (const j of seedJobs) {
    const jobId = crypto.randomUUID();
    await j.queue.add('download', { jobId, url: j.url, platform: j.platform }, { jobId, removeOnComplete: true });
    console.log(`Enqueued ${j.platform} ${j.url} -> ${jobId}`);
  }
  
  await connection.quit();
  process.exit(0);
}

run().catch(console.error);

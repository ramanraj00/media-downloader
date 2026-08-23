import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { randomUUID } from 'crypto';

const redis = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379');
const downloadQueue = new Queue('downloads', { connection: redis });

async function seed() {
  const url = "https://x.com/SpaceX/status/1725893322045612458";
  
  const jobId = randomUUID();
  console.log(`Enqueueing Twitter test job: ${jobId}`);
  
  await downloadQueue.add('download', {
    messageId: 8888,
    chatId: 9999,
    url,
    userId: 12345
  }, { jobId });
  
  console.log("Job enqueued.");
  process.exit(0);
}

seed().catch(console.error);

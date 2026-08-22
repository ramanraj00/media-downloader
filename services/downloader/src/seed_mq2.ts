import { config } from '@media-downloader/config';
import Redis from 'ioredis';
import { Queue } from 'bullmq';
import { QUEUES, Platform, JobStatus, DownloadJobData } from '@media-downloader/types';
import fs from 'fs';

const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
const qReddit = new Queue(QUEUES.DOWNLOAD.REDDIT, { connection: redis });
const qTiktok = new Queue(QUEUES.DOWNLOAD.TIKTOK, { connection: redis });

async function run() {
  const jobs = JSON.parse(fs.readFileSync('/tmp/jobs.json', 'utf8'));

  for (const job of jobs) {
    const jobData: DownloadJobData = {
      jobId: job.id,
      url: job.url,
      platform: job.platform,
      userId: job.userId,
      telegramChatId: 12345,
      statusMessageId: 111,
    };
    if (job.platform === 'REDDIT') {
      await qReddit.add('download', jobData, { jobId: jobData.jobId });
    } else {
      await qTiktok.add('download', jobData, { jobId: jobData.jobId });
    }
  }
  
  console.log('Seeded jobs to BullMQ directly with matching DB UUIDs!');
  process.exit(0);
}

run().catch(console.error);

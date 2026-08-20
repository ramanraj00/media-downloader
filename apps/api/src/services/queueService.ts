import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { config } from '@media-downloader/config';
import { QUEUES, DownloadJobData } from '@media-downloader/types';

const connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });

// Initialize queues
const instagramQueue = new Queue(QUEUES.DOWNLOAD.INSTAGRAM, { connection });
const twitterQueue = new Queue(QUEUES.DOWNLOAD.TWITTER, { connection });
const tiktokQueue = new Queue(QUEUES.DOWNLOAD.TIKTOK, { connection });
const redditQueue = new Queue(QUEUES.DOWNLOAD.REDDIT, { connection });

export async function enqueueDownloadJob(platform: string, data: DownloadJobData) {
  let queue: Queue;
  
  switch (platform) {
    case 'instagram':
      queue = instagramQueue;
      break;
    case 'twitter':
      queue = twitterQueue;
      break;
    case 'tiktok':
      queue = tiktokQueue;
      break;
    case 'reddit':
      queue = redditQueue;
      break;
    default:
      throw new Error(`Unsupported platform for queuing: ${platform}`);
  }

  await queue.add(
    'download', 
    data, 
    {
      jobId: data.jobId,
      removeOnComplete: true,
      removeOnFail: false,
      attempts: config.MAX_RETRIES,
      backoff: {
        type: 'exponential',
        delay: config.RETRY_BASE_DELAY_MS
      }
    }
  );
}

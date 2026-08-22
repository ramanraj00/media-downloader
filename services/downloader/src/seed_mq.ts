import { config } from '@media-downloader/config';
import Redis from 'ioredis';
import { Queue } from 'bullmq';
import { QUEUES, Platform, JobStatus, DownloadJobData } from '@media-downloader/types';
import crypto from 'crypto';

const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
const qReddit = new Queue(QUEUES.DOWNLOAD.REDDIT, { connection: redis });
const qTiktok = new Queue(QUEUES.DOWNLOAD.TIKTOK, { connection: redis });

const redditUrls = [
  'https://www.reddit.com/r/videos/comments/1f4x1/test_video_1/',
  'https://www.reddit.com/r/aww/comments/2g5y2/test_video_2/',
  'https://www.reddit.com/r/funny/comments/3h6z3/test_video_3/',
  'https://www.reddit.com/r/gaming/comments/4i7a4/test_video_4/',
  'https://www.reddit.com/r/movies/comments/5j8b5/test_video_5/',
  'https://www.reddit.com/r/music/comments/6k9c6/test_video_6/',
  'https://www.reddit.com/r/news/comments/7l0d7/test_video_7/',
  'https://www.reddit.com/r/science/comments/8m1e8/test_video_8/',
  'https://www.reddit.com/r/space/comments/9n2f9/test_video_9/',
  'https://www.reddit.com/r/technology/comments/0o3g0/test_video_10/'
];

const tiktokUrls = [
  'https://www.tiktok.com/@fake/video/7106594312292453671',
  'https://www.tiktok.com/@fake/video/7106594312292453672',
  'https://www.tiktok.com/@fake/video/7106594312292453673',
  'https://www.tiktok.com/@fake/video/7106594312292453674',
  'https://www.tiktok.com/@fake/video/7106594312292453675',
  'https://www.tiktok.com/@fake/video/7106594312292453676',
  'https://www.tiktok.com/@fake/video/7106594312292453677',
  'https://www.tiktok.com/@fake/video/7106594312292453678',
  'https://www.tiktok.com/@fake/video/7106594312292453679',
  'https://www.tiktok.com/@fake/video/7106594312292453680'
];

async function run() {
  for (let i = 0; i < redditUrls.length; i++) {
    const jobData: DownloadJobData = {
      jobId: crypto.randomUUID(),
      url: redditUrls[i],
      platform: Platform.REDDIT,
      userId: 1,
      telegramChatId: 12345,
      statusMessageId: 111,
    };
    await qReddit.add('download', jobData, { jobId: jobData.jobId });
  }

  for (let i = 0; i < tiktokUrls.length; i++) {
    const jobData: DownloadJobData = {
      jobId: crypto.randomUUID(),
      url: tiktokUrls[i],
      platform: Platform.TIKTOK,
      userId: 1,
      telegramChatId: 12345,
      statusMessageId: 111,
    };
    await qTiktok.add('download', jobData, { jobId: jobData.jobId });
  }
  
  console.log('Seeded 20 jobs to BullMQ directly with UUIDs!');
  process.exit(0);
}

run().catch(console.error);

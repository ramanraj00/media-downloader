import { db, jobs } from '@media-downloader/db';

const redditUrls = [
  'https://www.reddit.com/r/aww/comments/fake1',
  'https://www.reddit.com/r/aww/comments/fake2',
  'https://www.reddit.com/r/aww/comments/fake3',
  'https://www.reddit.com/r/aww/comments/fake4',
  'https://www.reddit.com/r/aww/comments/fake5',
  'https://www.reddit.com/r/aww/comments/fake6',
  'https://www.reddit.com/r/aww/comments/fake7',
  'https://www.reddit.com/r/aww/comments/fake8',
  'https://www.reddit.com/r/aww/comments/fake9',
  'https://www.reddit.com/r/aww/comments/fake10'
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
  for (const url of redditUrls) {
    await db.insert(jobs).values({
      url,
      platform: 'REDDIT' as any,
      status: 'PENDING' as any,
      userId: 'test_user',
      telegramChatId: '123'
    });
  }
  for (const url of tiktokUrls) {
    await db.insert(jobs).values({
      url,
      platform: 'TIKTOK' as any,
      status: 'PENDING' as any,
      userId: 'test_user',
      telegramChatId: '123'
    });
  }
  console.log('Seeded 20 jobs directly to DB');
  process.exit(0);
}

run().catch(console.error);

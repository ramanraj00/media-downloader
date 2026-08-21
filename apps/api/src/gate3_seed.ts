import { config } from '@media-downloader/config';
import { credentials, jobs, users, db } from '@media-downloader/db';
import { Queue } from 'bullmq';
import { QUEUES, JobStatus } from '@media-downloader/types';
import Redis from 'ioredis';
import { eq } from 'drizzle-orm';
import crypto from 'crypto';

async function seed() {
  console.log('Seeding mock credential and queuing synthetic job...');
  
  // 1. Insert mock credential
  const creds = await db.select().from(credentials).where(eq(credentials.platform, 'mock'));
  if (creds.length === 0) {
    await db.insert(credentials).values({
      platform: 'mock',
      encryptedData: 'synthetic_test_credential_payload'
    });
    console.log('Inserted mock credential');
  }

  // 2. Insert user
  let userList = await db.select().from(users).where(eq(users.telegramId, 12345));
  let userId;
  if (userList.length === 0) {
      const res = await db.insert(users).values({
          telegramId: 12345,
          username: 'test_user'
      }).returning({ id: users.id });
      userId = res[0].id;
  } else {
      userId = userList[0].id;
  }

  // 3. Insert mock job in DB
  const jobId = crypto.randomUUID();
  const mockUrl = `mock://test-video-${jobId}`;
  await db.insert(jobs).values({
    id: jobId,
    userId: userId,
    platform: 'mock',
    url: mockUrl,
    normalizedUrl: mockUrl,
    urlHash: crypto.createHash('sha256').update(mockUrl).digest('hex'),
    status: JobStatus.QUEUED,
    chatId: 123456789
  });

  // 4. Queue job
  const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
  const queue = new Queue(QUEUES.DOWNLOAD.INSTAGRAM, { connection: redis });
  
  await queue.add('mock', {
    jobId: jobId,
    url: mockUrl,
    platform: 'mock',
    userId: userId
  }, {
    jobId,
    attempts: 1
  });
  
  console.log(`Job enqueued with ID: ${jobId}`);
  process.exit(0);
}

seed().catch(err => {
  console.error(err);
  process.exit(1);
});

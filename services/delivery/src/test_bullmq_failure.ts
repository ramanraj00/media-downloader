import { Queue, QueueEvents } from 'bullmq';
import Redis from 'ioredis';
import { db, jobs, users } from '@media-downloader/db';
import { JobStatus, QUEUES } from '@media-downloader/types';
import { setupWorker } from './worker';
import { config } from '@media-downloader/config';
import { pino } from 'pino';
import { eq } from 'drizzle-orm';

async function runTest() {
  const connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
  const queue = new Queue(QUEUES.UPLOAD, { connection });
  const queueEvents = new QueueEvents(QUEUES.UPLOAD, { connection });
  
  const logger = pino({ level: 'silent' });
  const worker = await setupWorker(logger);

  const userRes = await db.insert(users).values({
    telegramId: Math.floor(Math.random() * 1000000),
    username: 'test_failure',
    activeJobs: 1,
    totalJobs: 1
  }).returning();
  const userId = userRes[0].id;

  const jobRes = await db.insert(jobs).values({
    userId,
    url: 'test-failure',
    normalizedUrl: 'test-failure',
    urlHash: `hash-${Date.now()}`,
    platform: 'test',
    status: JobStatus.UPLOADING,
    chatId: 123456789
  }).returning();
  const jobId = jobRes[0].id;
  
  console.log(`[TEST] Created user=${userId}, job=${jobId}`);
  
  queueEvents.on('active', ({ jobId: bJobId, prev }) => {
    if (bJobId === jobId) console.log(`\n[EVENT] active - prev state: ${prev}`);
  });

  queueEvents.on('failed', async ({ jobId: bJobId, failedReason }) => {
    if (bJobId === jobId) {
      console.log(`[EVENT] failed - reason: ${failedReason}`);
      
      const bullJob = await queue.getJob(bJobId);
      const attemptsMade = bullJob ? bullJob.attemptsMade : 'unknown';
      const maxAttempts = bullJob ? bullJob.opts.attempts : 'unknown';
      const isFailedState = bullJob ? await bullJob.isFailed() : 'unknown';
      
      const dbJob = await db.query.jobs.findFirst({ where: eq(jobs.id, jobId) });
      const dbUser = await db.query.users.findFirst({ where: eq(users.id, userId) });
      
      console.log(`    -> attemptsMade: ${attemptsMade}/${maxAttempts}`);
      console.log(`    -> job.isFailed() (in Redis): ${isFailedState}`);
      console.log(`    -> db jobs.status: ${dbJob?.status}`);
      console.log(`    -> db users.activeJobs: ${dbUser?.activeJobs}`);
      
      if (attemptsMade === maxAttempts) {
        console.log(`\n[TEST] Final attempt reached. Checking final database state in 2s...`);
        setTimeout(async () => {
          const finalJob = await db.query.jobs.findFirst({ where: eq(jobs.id, jobId) });
          const finalUser = await db.query.users.findFirst({ where: eq(users.id, userId) });
          console.log(`[FINAL DB] jobs.status = ${finalJob?.status}`);
          console.log(`[FINAL DB] users.activeJobs = ${finalUser?.activeJobs}`);
          
          await worker.close();
          await queueEvents.close();
          await queue.close();
          await connection.quit();
          process.exit(0);
        }, 2000);
      }
    }
  });

  console.log(`[TEST] Adding job to BullMQ queue...`);
  await queue.add('upload', {
    jobId,
    processedPath: '/tmp/nonexistent-file.mp4',
    mediaType: 'video'
  }, {
    jobId,
    attempts: config.MAX_RETRIES,
    backoff: { type: 'exponential', delay: 1000 }
  });
}

runTest().catch(console.error);

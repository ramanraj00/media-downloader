import { Queue, Worker, QueueEvents } from 'bullmq';
import Redis from 'ioredis';
import { db, jobs, users } from '@media-downloader/db';
import { eq, sql } from 'drizzle-orm';
import { JobStatus, QUEUES } from '@media-downloader/types';
import { config } from '@media-downloader/config';

async function setupTerminalFailureHandler(queueName: string, connection: Redis) {
  const queueEvents = new QueueEvents(queueName, { connection });
  const queue = new Queue(queueName, { connection });

  queueEvents.on('failed', async ({ jobId, failedReason }) => {
    if (!jobId) return;
    const job = await queue.getJob(jobId);
    if (!job) return;

    // A job is permanently failed if its state in Redis is 'failed'.
    // If it is going to retry, its state will be 'delayed' or 'waiting'.
    const state = await job.getState();
    const isTerminal = state === 'failed';

    await db.transaction(async (tx) => {
      const currentJob = await tx.query.jobs.findFirst({ where: eq(jobs.id, jobId) });
      if (!currentJob) return;

      if (isTerminal) {
        // Idempotency: skip if already terminal
        if (currentJob.status === JobStatus.FAILED_PERMANENTLY || currentJob.status === JobStatus.COMPLETED) {
          console.log(`[LIFECYCLE] Job ${jobId} already terminal (${currentJob.status}). Idempotency guard triggered.`);
          return;
        }

        // TELEGRAM_UPLOADED cannot fail permanently
        if (currentJob.status === JobStatus.TELEGRAM_UPLOADED) {
          console.log(`[LIFECYCLE] Job ${jobId} is TELEGRAM_UPLOADED. Ignoring FAILED_PERMANENTLY transition.`);
          return;
        }

        const result = await tx.update(jobs)
          .set({ status: JobStatus.FAILED_PERMANENTLY, error: failedReason, updatedAt: new Date() })
          .where(eq(jobs.id, jobId))
          .returning();
          
        if (result.length > 0) {
          await tx.update(users)
            .set({ activeJobs: sql`${users.activeJobs} - 1` })
            .where(sql`${users.id} = ${currentJob.userId} AND ${users.activeJobs} > 0`);
          console.log(`[LIFECYCLE] Job ${jobId} -> FAILED_PERMANENTLY. Quota released (-1).`);
        }
      } else {
        await tx.update(jobs)
          .set({ status: JobStatus.RETRY_PENDING, error: failedReason, updatedAt: new Date() })
          .where(eq(jobs.id, jobId));
        console.log(`[LIFECYCLE] Job ${jobId} -> RETRY_PENDING. State: ${state}`);
      }
    });
  });
  return queueEvents;
}

async function run() {
  const connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
  const queueName = 'test-lifecycle-' + Date.now();
  const queue = new Queue(queueName, { connection });
  
  const queueEvents = await setupTerminalFailureHandler(queueName, connection);

  // Setup mock user
  const user = await db.insert(users).values({
    telegramId: Date.now(),
    username: 'test_lifecycle',
    activeJobs: 4,
  }).returning().then(r => r[0]);

  let transientAttempts = 0;
  let exhaustedAttempts = 0;
  
  const worker = new Worker(queueName, async (bullJob) => {
    if (bullJob.name === 'transient') {
      transientAttempts++;
      if (transientAttempts < 2) {
        console.log(`[WORKER] Transient Error (Attempt ${transientAttempts})`);
        throw new Error('Network timeout');
      }
      console.log(`[WORKER] Transient Success (Attempt ${transientAttempts})`);
      
      // Mimic Delivery worker success
      await db.transaction(async (tx) => {
        await tx.update(jobs).set({ status: JobStatus.COMPLETED }).where(eq(jobs.id, bullJob.data.jobId));
        await tx.update(users).set({ activeJobs: sql`${users.activeJobs} - 1` }).where(eq(users.id, user.id));
      });
      return 'success';
      
    } else if (bullJob.name === 'exhausted') {
      exhaustedAttempts++;
      console.log(`[WORKER] Exhausted Error (Attempt ${exhaustedAttempts})`);
      throw new Error('Persistent failure');
      
    } else if (bullJob.name === 'terminal') {
      console.log(`[WORKER] >50MB detected. Throwing UnrecoverableError`);
      const { UnrecoverableError } = require('bullmq');
      throw new UnrecoverableError('>50MB limit exceeded');
      
    } else if (bullJob.name === 'telegram_uploaded') {
      console.log(`[WORKER] Telegram Uploaded Finalization failure`);
      const { UnrecoverableError } = require('bullmq');
      throw new UnrecoverableError('Could not finalize');
    }
  }, { connection });

  console.log('\n--- TEST 1: Transient Error -> Retry -> Success ---');
  const job1 = await db.insert(jobs).values({
    userId: user.id, platform: 'test', url: 't1', normalizedUrl: 't1', urlHash: 't1', chatId: 123, status: JobStatus.DOWNLOADING
  }).returning().then(r => r[0]);

  await queue.add('transient', { jobId: job1.id }, { attempts: 3, backoff: { type: 'fixed', delay: 100 }, jobId: job1.id });
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  const j1_state = await db.query.jobs.findFirst({ where: eq(jobs.id, job1.id) });
  console.log(`Job 1 Final DB Status: ${j1_state?.status} (Expected: completed)`);

  console.log('\n--- TEST 2: MAX_RETRIES exhaustion -> exactly one quota decrement ---');
  const job2 = await db.insert(jobs).values({
    userId: user.id, platform: 'test', url: 't2', normalizedUrl: 't2', urlHash: 't2', chatId: 123, status: JobStatus.DOWNLOADING
  }).returning().then(r => r[0]);

  await queue.add('exhausted', { jobId: job2.id }, { attempts: 3, backoff: { type: 'fixed', delay: 100 }, jobId: job2.id });
  await new Promise(resolve => setTimeout(resolve, 1500));
  
  const j2_state = await db.query.jobs.findFirst({ where: eq(jobs.id, job2.id) });
  console.log(`Job 2 Final DB Status: ${j2_state?.status} (Expected: failed_permanently)`);

  console.log('\n--- TEST 3: UnrecoverableError -> no retry -> exactly one quota decrement ---');
  const job3 = await db.insert(jobs).values({
    userId: user.id, platform: 'test', url: 't3', normalizedUrl: 't3', urlHash: 't3', chatId: 123, status: JobStatus.PROCESSING_MEDIA
  }).returning().then(r => r[0]);

  await queue.add('terminal', { jobId: job3.id }, { attempts: 3, backoff: { type: 'fixed', delay: 100 }, jobId: job3.id });
  await new Promise(resolve => setTimeout(resolve, 500));
  
  const j3_state = await db.query.jobs.findFirst({ where: eq(jobs.id, job3.id) });
  console.log(`Job 3 Final DB Status: ${j3_state?.status} (Expected: failed_permanently)`);

  console.log('\n--- TEST 4: Duplicate terminal-failure event ---');
  console.log(`[SIMULATION] Re-emitting 'failed' event manually for Job 3`);
  (queueEvents as any).emit('failed', { jobId: job3.id, failedReason: '>50MB limit exceeded', prev: 'active' }, job3.id);
  await new Promise(resolve => setTimeout(resolve, 500));

  console.log('\n--- TEST 5: Delivery TELEGRAM_UPLOADED ---');
  const job5 = await db.insert(jobs).values({
    userId: user.id, platform: 'test', url: 't5', normalizedUrl: 't5', urlHash: 't5', chatId: 123, status: JobStatus.TELEGRAM_UPLOADED
  }).returning().then(r => r[0]);

  await queue.add('telegram_uploaded', { jobId: job5.id }, { attempts: 3, backoff: { type: 'fixed', delay: 100 }, jobId: job5.id });
  await new Promise(resolve => setTimeout(resolve, 500));
  
  const j5_state = await db.query.jobs.findFirst({ where: eq(jobs.id, job5.id) });
  console.log(`Job 5 Final DB Status: ${j5_state?.status} (Expected: telegram_uploaded)`);

  const finalUser = await db.query.users.findFirst({ where: eq(users.id, user.id) });
  console.log(`\n--- RESULTS ---`);
  console.log(`Initial activeJobs: 4`);
  console.log(`Final User activeJobs: ${finalUser?.activeJobs} (Expected: 1)`);
  // Job 1 -> -1 (COMPLETED)
  // Job 2 -> -1 (FAILED_PERMANENTLY)
  // Job 3 -> -1 (FAILED_PERMANENTLY, duplicate event ignored)
  // Job 5 -> 0 (Ignored FAILED_PERMANENTLY transition)
  
  process.exit(0);
}
run().catch(console.error);

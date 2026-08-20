import { Queue, Worker, QueueEvents } from 'bullmq';
import Redis from 'ioredis';
import { db, jobs, users } from '@media-downloader/db';
import { eq, sql } from 'drizzle-orm';
import { JobStatus } from '@media-downloader/types';
import { config } from '@media-downloader/config';

async function runChaosTest() {
  const connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
  const queueName = 'test-chaos-' + Date.now();
  const queue = new Queue(queueName, { connection });
  const queueEvents = new QueueEvents(queueName, { connection });

  // Mock users
  const user1 = await db.insert(users).values({ telegramId: Date.now() + 1, username: 'chaos1', activeJobs: 1 }).returning().then(r => r[0]);
  const user2 = await db.insert(users).values({ telegramId: Date.now() + 2, username: 'chaos2', activeJobs: 1 }).returning().then(r => r[0]);
  
  const job1 = await db.insert(jobs).values({ userId: user1.id, platform: 'test', url: 't1', normalizedUrl: 't1', urlHash: 't1_' + Date.now(), chatId: 123, status: JobStatus.DOWNLOADING }).returning().then(r => r[0]);
  const job2 = await db.insert(jobs).values({ userId: user2.id, platform: 'test', url: 't2', normalizedUrl: 't2', urlHash: 't2_' + Date.now(), chatId: 123, status: JobStatus.DOWNLOADING }).returning().then(r => r[0]);

  // Worker that always throws terminal error
  const worker = new Worker(queueName, async () => {
    const { UnrecoverableError } = require('bullmq');
    throw new UnrecoverableError('chaos_error');
  }, { connection });

  let simulatedDbFailure = true;

  queueEvents.on('failed', async ({ jobId, failedReason }) => {
    if (!jobId) return;
    const job = await queue.getJob(jobId);
    if (!job) return;

    const state = await job.getState();
    const isTerminal = state === 'failed';

    await db.transaction(async (tx) => {
      const currentJob = await tx.query.jobs.findFirst({ where: eq(jobs.id, jobId) });
      if (!currentJob) return;

      if (isTerminal) {
        if (currentJob.status === JobStatus.FAILED_PERMANENTLY) {
          console.log(`[CHAOS] Job ${jobId} already terminal. Idempotency guard triggered.`);
          return;
        }

        const result = await tx.update(jobs)
          .set({ status: JobStatus.FAILED_PERMANENTLY, error: failedReason, updatedAt: new Date() })
          .where(eq(jobs.id, jobId))
          .returning();

        // INJECT CHAOS
        if (jobId === job1.id && simulatedDbFailure) {
           console.log(`[CHAOS] Injecting Postgres failure during terminal handler for Job 1!`);
           throw new Error('Simulated DB Network Failure / Process Crash during transaction');
        }
          
        if (result.length > 0) {
          await tx.update(users)
            .set({ activeJobs: sql`${users.activeJobs} - 1` })
            .where(sql`${users.id} = ${currentJob.userId} AND ${users.activeJobs} > 0`);
          console.log(`[CHAOS] Job ${jobId} -> FAILED_PERMANENTLY. Quota released.`);
        }
      }
    }).catch(err => {
       console.log(`[CHAOS] Transaction rolled back: ${err.message}`);
    });
  });

  console.log('\n--- CHAOS TEST 1: DB Failure During Terminal Handler ---');
  await queue.add('chaos_fail', { jobId: job1.id }, { attempts: 1, jobId: job1.id });
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  let j1_state = await db.query.jobs.findFirst({ where: eq(jobs.id, job1.id) });
  let u1_state = await db.query.users.findFirst({ where: eq(users.id, user1.id) });
  console.log(`Job 1 State after crash: ${j1_state?.status} (Expected: downloading)`);
  console.log(`User 1 ActiveJobs after crash: ${u1_state?.activeJobs} (Expected: 1)`);

  console.log('\n--- CHAOS TEST 2: Publisher Restart (Re-emit failed event) ---');
  simulatedDbFailure = false; // "Restarted" publisher without crash
  console.log(`[CHAOS] Publisher restarted. Re-emitting 'failed' event for Job 1`);
  (queueEvents as any).emit('failed', { jobId: job1.id, failedReason: 'chaos_error', prev: 'active' }, job1.id);
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  j1_state = await db.query.jobs.findFirst({ where: eq(jobs.id, job1.id) });
  u1_state = await db.query.users.findFirst({ where: eq(users.id, user1.id) });
  console.log(`Job 1 State after restart: ${j1_state?.status} (Expected: failed_permanently)`);
  console.log(`User 1 ActiveJobs after restart: ${u1_state?.activeJobs} (Expected: 0)`);

  console.log('\n--- CHAOS TEST 3: Multiple Publisher Instances (Race Condition Simulation) ---');
  // Both instances receive the 'failed' event at the exact same time
  await queue.add('chaos_fail2', { jobId: job2.id }, { attempts: 1, jobId: job2.id });
  
  // Wait for worker to fail it, so it's 'failed' in Redis
  await new Promise(resolve => setTimeout(resolve, 500));
  
  // Now emit the event manually multiple times simultaneously to simulate multiple listeners
  console.log(`[CHAOS] Emitting 'failed' 3 times concurrently for Job 2`);
  (queueEvents as any).emit('failed', { jobId: job2.id, failedReason: 'chaos_error', prev: 'active' }, job2.id);
  (queueEvents as any).emit('failed', { jobId: job2.id, failedReason: 'chaos_error', prev: 'active' }, job2.id);
  (queueEvents as any).emit('failed', { jobId: job2.id, failedReason: 'chaos_error', prev: 'active' }, job2.id);
  
  await new Promise(resolve => setTimeout(resolve, 1500));

  let j2_state = await db.query.jobs.findFirst({ where: eq(jobs.id, job2.id) });
  let u2_state = await db.query.users.findFirst({ where: eq(users.id, user2.id) });
  
  console.log(`Job 2 State: ${j2_state?.status} (Expected: failed_permanently)`);
  console.log(`User 2 ActiveJobs: ${u2_state?.activeJobs} (Expected: 0, NO NEGATIVE VALUES)`);

  process.exit(0);
}
runChaosTest().catch(console.error);

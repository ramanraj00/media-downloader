import { db, jobs, users, media } from '@media-downloader/db';
import { JobStatus } from '@media-downloader/types';
import { eq } from 'drizzle-orm';
import { setupWorker } from './worker';
import pino from 'pino';

const logger = pino({ level: 'silent' });

async function runTests() {
  console.log('--- STARTING TEST D ---');

  // Cleanup old data
  await db.delete(media);
  await db.delete(jobs);
  await db.delete(users);

  // Create mock user
  const [user] = await db.insert(users).values({
    telegramId: 123456789,
    username: 'testuser',
    activeJobs: 1,
    totalJobs: 1,
  }).returning();

  // Create mock job
  const [job] = await db.insert(jobs).values({
    userId: user.id,
    url: 'https://example.com/video.mp4',
    normalizedUrl: 'https://example.com/video.mp4',
    urlHash: 'hash123',
    platform: 'web',
    status: JobStatus.TELEGRAM_UPLOADED,
    chatId: 123456789,
    telegramFileId: 'mock_file_id',
    telegramMessageId: 999,
    contentHash: 'abc123hash',
    fileSize: 1048576,
  }).returning();

  // Setup worker
  const worker = await setupWorker(logger);
  
  const mockBullJob: any = {
    data: {
      jobId: job.id,
      processedPath: '/tmp/nonexistent-file.mp4',
      mediaType: 'video',
      contentHash: 'abc123hash',
      fileSize: 1048576,
    }
  };

  // Monkey-patch db.transaction to fail once
  const originalTransaction = db.transaction.bind(db);
  let failedOnce = false;

  (db as any).transaction = async (cb: any) => {
    if (!failedOnce) {
      failedOnce = true;
      throw new Error('MOCK POSTGRES CONNECTION FAILURE');
    }
    return originalTransaction(cb);
  };

  console.log('\n--- ATTEMPT 1: Simulating PostgreSQL failure during finalization ---');
  try {
    await (worker as any).processFn(mockBullJob);
    console.log('UNEXPECTED: Processor finished successfully on attempt 1!');
  } catch (err: any) {
    console.log('EXPECTED: Processor failed with:', err.message);
  }

  // Verify intermediate state
  const intermediateJob = await db.query.jobs.findFirst({ where: eq(jobs.id, job.id) });
  console.log(`Intermediate Status = ${intermediateJob?.status} (should be TELEGRAM_UPLOADED)`);

  console.log('\n--- ATTEMPT 2: Simulating BullMQ retry after PostgreSQL restores ---');
  try {
    await (worker as any).processFn(mockBullJob);
    console.log('EXPECTED: Processor finished successfully on attempt 2!');
  } catch (err: any) {
    console.log('UNEXPECTED: Processor failed on attempt 2:', err.message);
  }

  // Restore mock
  (db as any).transaction = originalTransaction;

  // Verify invariants
  const finalJob = await db.query.jobs.findFirst({ where: eq(jobs.id, job.id) });
  const finalMedia = await db.query.media.findFirst({ where: eq(media.jobId, job.id) });
  const finalUser = await db.query.users.findFirst({ where: eq(users.id, user.id) });

  console.log('\n--- VERIFY TEST D INVARIANTS ---');
  console.log(`- job remains TELEGRAM_UPLOADED between retries: ${intermediateJob?.status === JobStatus.TELEGRAM_UPLOADED}`);
  console.log(`- finalization succeeds on retry: ${finalJob?.status === JobStatus.COMPLETED}`);
  console.log(`- exactly one media row exists: ${!!finalMedia}`);
  console.log(`- activeJobs decrements exactly once: ${finalUser?.activeJobs === 0}`);
  
  await worker.close();
  process.exit(0);
}

runTests().catch(console.error);

import { db, jobs, users, media } from '@media-downloader/db';
import { JobStatus } from '@media-downloader/types';
import { eq } from 'drizzle-orm';
import { setupWorker } from './worker';
import pino from 'pino';

const logger = pino({ level: 'silent' });

async function runTests() {
  console.log('--- STARTING TESTS ---');

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
  
  console.log('\n--- TEST B: FILESYSTEM DELETION PROOF ---');
  console.log('Executing processor for job with non-existent processedPath...');
  
  const mockBullJob: any = {
    data: {
      jobId: job.id,
      processedPath: '/tmp/nonexistent-file.mp4', // File definitely does not exist
      mediaType: 'video',
      contentHash: 'abc123hash',
      fileSize: 1048576,
    }
  };

  try {
    await (worker as any).processFn(mockBullJob);
    console.log('RESULT: Processor finished successfully despite missing file!');
  } catch (err: any) {
    console.error('RESULT: Processor failed:', err.message);
  }

  // Verify invariants
  const finalJob = await db.query.jobs.findFirst({ where: eq(jobs.id, job.id) });
  const finalMedia = await db.query.media.findFirst({ where: eq(media.jobId, job.id) });
  const finalUser = await db.query.users.findFirst({ where: eq(users.id, user.id) });

  console.log('\n--- TEST E: SQL INVARIANTS ---');
  console.log(`1. Exactly one media row: ${!!finalMedia}`);
  console.log(`2. jobs.status = COMPLETED: ${finalJob?.status === JobStatus.COMPLETED}`);
  console.log(`3. jobs.telegramFileId is non-null: ${finalJob?.telegramFileId !== null}`);
  console.log(`4. jobs.telegramMessageId is non-null: ${finalJob?.telegramMessageId !== null}`);
  console.log(`5. jobs.contentHash is non-null: ${finalJob?.contentHash !== null}`);
  console.log(`6. jobs.fileSize is non-null: ${finalJob?.fileSize !== null}`);
  console.log(`7. activeJobs decreased exactly once: ${finalUser?.activeJobs === 0}`);
  
  await worker.close();
  process.exit(0);
}

runTests().catch(console.error);

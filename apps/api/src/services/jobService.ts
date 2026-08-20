import crypto from 'node:crypto';
import { db, jobs, users, outboxEvents } from '@media-downloader/db';
import { normalizeUrl, hashUrl, detectPlatform, isSupportedUrl, UnsupportedURLError } from '@media-downloader/core';
import { JobStatus, Platform, DownloadJobData, OutboxEventType } from '@media-downloader/types';
import { eq, and, gt } from 'drizzle-orm';
import { config } from '@media-downloader/config';
import Redis from 'ioredis';

const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });

interface SubmitJobRequest {
  url: string;
  userId: number;
  chatId: number;
  statusMessageId?: number;
}

export async function submitJob(req: SubmitJobRequest) {
  const { url, userId, chatId, statusMessageId } = req;

  if (!isSupportedUrl(url)) {
    throw new UnsupportedURLError();
  }

  const normalizedUrl = normalizeUrl(url);
  const urlHash = hashUrl(normalizedUrl);
  const platform = detectPlatform(normalizedUrl);

  // 1. Ensure user exists
  await db.insert(users)
    .values({ telegramId: userId })
    .onConflictDoNothing({ target: users.telegramId });

  const user = await db.query.users.findFirst({
    where: eq(users.telegramId, userId)
  });

  if (!user) throw new Error("User not found after upsert");

  // 2. Rate limiting check (user max active jobs)
  if (user.activeJobs >= config.USER_MAX_ACTIVE_JOBS) {
    throw new Error(`Rate limit exceeded: You can only have ${config.USER_MAX_ACTIVE_JOBS} active downloads at once.`);
  }

  // 3. Idempotency Check & Redis Lock
  const lockKey = `lock:job:${urlHash}`;
  const lockToken = crypto.randomUUID();

  const acquired = await redis.set(
    lockKey,
    lockToken,
    'EX',
    15,
    'NX'
  );
  
  if (!acquired) {
    return {
      jobId: 'pending_lock',
      status: JobStatus.QUEUED,
      isDuplicate: true
    };
  }

  try {
    const existingJob = await db.query.jobs.findFirst({
      where: and(
        eq(jobs.urlHash, urlHash),
        gt(jobs.createdAt, new Date(Date.now() - 24 * 60 * 60 * 1000)) // Within last 24h
      ),
      orderBy: (jobs, { desc }) => [desc(jobs.createdAt)]
    });

    if (existingJob && [JobStatus.COMPLETED, JobStatus.QUEUED, JobStatus.PROCESSING, JobStatus.DOWNLOADING].includes(existingJob.status as JobStatus)) {
      return {
        jobId: existingJob.id,
        status: existingJob.status,
        isDuplicate: true,
        telegramFileId: existingJob.telegramFileId
      };
    }

    // 4. Create new job inside a transaction
    return await db.transaction(async (tx) => {
      const [newJob] = await tx.insert(jobs).values({
        userId: user.id,
        url,
        normalizedUrl,
        urlHash,
        platform,
        chatId,
        statusMessageId,
        status: JobStatus.QUEUED,
      }).onConflictDoNothing({ target: jobs.urlHash }).returning();

      if (!newJob) {
        const existingJob = await tx.query.jobs.findFirst({
          where: eq(jobs.urlHash, urlHash),
        });

        if (!existingJob) {
          throw new Error('Job conflict occurred but existing job could not be found');
        }

        return {
          jobId: existingJob.id,
          status: existingJob.status,
          isDuplicate: true,
          telegramFileId: existingJob.telegramFileId,
        };
      }

      // 5. Update user active jobs count
      await tx.update(users)
        .set({ activeJobs: user.activeJobs + 1, totalJobs: user.totalJobs + 1 })
        .where(eq(users.id, user.id));

      // 6. Create outbox event
      const jobData: DownloadJobData = {
        jobId: newJob.id,
        url: newJob.url,
        urlHash: newJob.urlHash,
        platform: newJob.platform,
      };

      await tx.insert(outboxEvents).values({
        eventType: OutboxEventType.DOWNLOAD_REQUESTED,
        aggregateId: newJob.id,
        payload: jobData,
      });

      return {
        jobId: newJob.id,
        status: JobStatus.QUEUED,
        isDuplicate: false
      };
    });
  } finally {
    await redis.eval(
      `
        if redis.call("GET", KEYS[1]) == ARGV[1] then
          return redis.call("DEL", KEYS[1])
        else
          return 0
        end
      `,
      1,
      lockKey,
      lockToken
    );
  }
}

export async function getJobStatus(jobId: string) {
  return await db.query.jobs.findFirst({
    where: eq(jobs.id, jobId)
  });
}

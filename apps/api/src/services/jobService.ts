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

export let lockAcquisitionWinnerCounter = 0;
export function resetLockAcquisitionWinnerCounter() {
  lockAcquisitionWinnerCounter = 0;
}

const activeStatuses = [
  JobStatus.QUEUED,
  JobStatus.DOWNLOADING,
  JobStatus.PROCESSING,
  JobStatus.PROCESSING_MEDIA,
  JobStatus.VALIDATING,
  JobStatus.UPLOADING,
  JobStatus.TELEGRAM_UPLOADED,
  JobStatus.COMPLETED,
];

async function waitForJobByHash(urlHash: string) {
  const pubSubChannel = `pubsub:job:${urlHash}`;
  const subRedis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });

  return new Promise<{ jobId: string; status: string; isDuplicate: true; telegramFileId?: string | null }>((resolve, reject) => {
    let resolved = false;
    let pollTimer: NodeJS.Timeout;

    const cleanup = () => {
      resolved = true;
      if (pollTimer) clearInterval(pollTimer);
      subRedis.unsubscribe(pubSubChannel).catch(() => {});
      subRedis.quit().catch(() => {});
    };

    subRedis.subscribe(pubSubChannel, (err) => {
      if (err && !resolved) {
        // DB polling handles fallback
      }
    });

    subRedis.on('message', (_channel, message) => {
      if (resolved) return;
      try {
        const payload = JSON.parse(message);
        cleanup();
        resolve({
          jobId: payload.jobId,
          status: payload.status || JobStatus.QUEUED,
          isDuplicate: true,
          telegramFileId: payload.telegramFileId || null
        });
      } catch (e) {
        // Let poll fallback handle parse failure
      }
    });

    const startTime = Date.now();
    const checkDb = async () => {
      if (resolved) return;
      try {
        const existingJob = await db.query.jobs.findFirst({
          where: and(
            eq(jobs.urlHash, urlHash),
            gt(jobs.createdAt, new Date(Date.now() - 24 * 60 * 60 * 1000))
          ),
          orderBy: (jobs, { desc }) => [desc(jobs.createdAt)]
        });

        if (existingJob && activeStatuses.includes(existingJob.status as JobStatus) && !resolved) {
          cleanup();
          return resolve({
            jobId: existingJob.id,
            status: existingJob.status,
            isDuplicate: true,
            telegramFileId: existingJob.telegramFileId
          });
        }
      } catch (err) {
        // Retry poll
      }

      if (Date.now() - startTime > 10000 && !resolved) {
        cleanup();
        reject(new Error(`Timeout waiting for canonical job creation for hash ${urlHash}`));
      }
    };

    checkDb();
    pollTimer = setInterval(checkDb, 150);
  });
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

  // 2. Quick DB check before locking (fast path if job already exists & active)
  const quickJob = await db.query.jobs.findFirst({
    where: and(
      eq(jobs.urlHash, urlHash),
      gt(jobs.createdAt, new Date(Date.now() - 24 * 60 * 60 * 1000))
    ),
    orderBy: (jobs, { desc }) => [desc(jobs.createdAt)]
  });

  if (quickJob && activeStatuses.includes(quickJob.status as JobStatus)) {
    return {
      jobId: quickJob.id,
      status: quickJob.status,
      isDuplicate: true,
      telegramFileId: quickJob.telegramFileId
    };
  }

  // 3. Idempotency Check & Redis Lock
  const lockKey = `lock:job:${urlHash}`;
  const lockToken = crypto.randomUUID();

  const acquired = await redis.set(
    lockKey,
    lockToken,
    'EX',
    30,
    'NX'
  );
  
  if (!acquired) {
    // Wait for the lock owner to finish creating job / broadcasting
    return await waitForJobByHash(urlHash);
  }

  await redis.incr('metric:lock_winners');
  const pubSubChannel = `pubsub:job:${urlHash}`;

  try {
    const existingJob = await db.query.jobs.findFirst({
      where: and(
        eq(jobs.urlHash, urlHash),
        gt(jobs.createdAt, new Date(Date.now() - 24 * 60 * 60 * 1000))
      ),
      orderBy: (jobs, { desc }) => [desc(jobs.createdAt)]
    });

    if (existingJob && activeStatuses.includes(existingJob.status as JobStatus)) {
      const res = {
        jobId: existingJob.id,
        status: existingJob.status,
        isDuplicate: true,
        telegramFileId: existingJob.telegramFileId
      };
      await redis.publish(pubSubChannel, JSON.stringify(res));
      return res;
    }

    // 4. Create new job inside a transaction
    const result = await db.transaction(async (tx) => {
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
        
        if (existingJob.status === 'failed_permanently' || existingJob.status === 'failed_transiently') {
           // Reset the job and retry
           const [updatedJob] = await tx.update(jobs)
              .set({ status: 'queued', updatedAt: new Date(), })
              .where(eq(jobs.id, existingJob.id))
              .returning();
           
           await tx.insert(outboxEvents).values({
              eventType: 'DOWNLOAD_REQUESTED',
              aggregateId: updatedJob.id,
              payload: {
                jobId: updatedJob.id,
                url: updatedJob.url,
                urlHash: updatedJob.urlHash,
                platform: updatedJob.platform,
              },
           });
           
           return {
             jobId: updatedJob.id,
             status: 'queued',
             isDuplicate: false,
           };
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

    await redis.publish(pubSubChannel, JSON.stringify(result));
    return result;
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

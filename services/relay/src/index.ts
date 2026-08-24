import { db, outboxEvents, jobs, users } from '@media-downloader/db';
import { OutboxEventType, DownloadJobData, QUEUES, JobStatus } from '@media-downloader/types';
import { eq, and, lte, sql } from 'drizzle-orm';
import { enqueueDownloadJob } from '../../../apps/api/src/services/queueService';
import { createLogger } from '@media-downloader/logger';
import { QueueEvents, Queue } from 'bullmq';
import Redis from 'ioredis';
import { config } from '@media-downloader/config';

const logger = createLogger('outbox-publisher');

export async function processPendingEvents() {
  try {
    // 1. Claim a pending event in a short transaction
    const claimedEvent = await db.transaction(async (tx) => {
      const events = await tx
        .select()
        .from(outboxEvents)
        .where(eq(outboxEvents.status, 'pending'))
        .limit(1)
        .for('update', { skipLocked: true });

      if (events.length === 0) {
        return null;
      }

      const event = events[0];
      const newAttempts = event.attempts + 1;

      // Atomically mark as processing while holding the lock
      await tx.update(outboxEvents)
        .set({
          status: 'processing',
          attempts: newAttempts,
          updatedAt: new Date()
        })
        .where(eq(outboxEvents.id, event.id));

      return { ...event, attempts: newAttempts };
    });

    if (!claimedEvent) {
      return; // No pending events available right now
    }

    logger.info({ eventId: claimedEvent.id, type: claimedEvent.eventType }, 'Claimed outbox event for processing');

    // 2. Perform the network call outside the lock
    try {
      if (claimedEvent.eventType === OutboxEventType.DOWNLOAD_REQUESTED) {
        const payload = claimedEvent.payload as unknown as DownloadJobData;
        await enqueueDownloadJob(payload.platform, payload);
      } else if (claimedEvent.eventType === OutboxEventType.JOB_COMPLETED) {
        const payload = claimedEvent.payload as any;
        
        // At-least-once delivery to Telegram (No Redis SETNX guard)
        // If a crash occurs during delivery, the event remains in 'processing' 
        // and is later recovered to 'pending', causing a retry (potential duplicate).
        logger.info({ eventId: claimedEvent.id }, 'Delivering JOB_COMPLETED notification to Bot Service / Telegram');
        
        // The Delivery service already directly sends the video/photo to the user via bot.api.
        // There is no need to send it again here. This event is strictly for webhooks if we add them later.
      } else {
        throw new Error(`Unimplemented event type: ${claimedEvent.eventType}`);
      }
      
      // 3. Mark as published in a new short update (ONLY IF 200 OK)
      await db.update(outboxEvents)
        .set({
          status: 'published',
          publishedAt: new Date(),
          updatedAt: new Date()
        })
        .where(eq(outboxEvents.id, claimedEvent.id));
        
      logger.info({ eventId: claimedEvent.id }, 'Successfully published outbox event');
    } catch (error: any) {
      logger.error({ eventId: claimedEvent.id, err: error }, 'Failed to publish outbox event');
      
      // 4. Handle failure with exponential backoff and return to pending
      // Cap the backoff at 10 attempts (approx 17 minutes) to avoid Postgres date overflow
      const maxAttemptsForBackoff = Math.min(claimedEvent.attempts, 10);
      const delayMs = Math.pow(2, maxAttemptsForBackoff) * 1000;
      const nextAvailableAt = new Date(Date.now() + delayMs);

      await db.update(outboxEvents)
        .set({
          status: 'pending',
          lastError: error.message,
          availableAt: nextAvailableAt,
          updatedAt: new Date()
        })
        .where(eq(outboxEvents.id, claimedEvent.id));
    }
  } catch (err) {
    logger.error({ err }, 'Error in publisher loop');
  }
}

const LEASE_TIMEOUT_MS = 10_000;

async function recoverStuckEvents() {
  try {
    const timeoutLimit = new Date(Date.now() - LEASE_TIMEOUT_MS);
    const recovered = await db.update(outboxEvents)
      .set({
        status: 'pending',
        updatedAt: new Date()
      })
      .where(
        and(
          eq(outboxEvents.status, 'processing'),
          lte(outboxEvents.updatedAt, timeoutLimit)
        )
      )
      .returning({ id: outboxEvents.id });

    if (recovered.length > 0) {
      logger.warn({ count: recovered.length, eventIds: recovered.map(r => r.id) }, 'Recovered stuck outbox events');
    }
  } catch (err) {
    logger.error({ err }, 'Error in recoverStuckEvents');
  }
}

export async function handleTerminalFailure(jobId: string, failedReason: string, queueName: string, queue: Queue) {
  try {
    const job = await queue.getJob(jobId);
    if (!job) return;

    const state = await job.getState();
    const isTerminal = state === 'failed';

    const currentJob = await db.query.jobs.findFirst({ where: eq(jobs.id, jobId) });
    if (!currentJob) return;

    await db.transaction(async (tx) => {
      if (isTerminal) {
        if (currentJob.status === JobStatus.FAILED_PERMANENTLY || currentJob.status === JobStatus.COMPLETED) {
          logger.info({ jobId }, 'Job already terminal. Idempotency guard triggered.');
          return;
        }

        if (currentJob.status === JobStatus.TELEGRAM_UPLOADED) {
          logger.warn({ jobId }, 'Terminal failure for TELEGRAM_UPLOADED job. Ignored FAILED_PERMANENTLY transition.');
          return;
        }

        const result = await tx.update(jobs)
          .set({ status: JobStatus.FAILED_PERMANENTLY, error: failedReason, updatedAt: new Date() })
          .where(eq(jobs.id, jobId))
          .returning();
          
        if (result.length > 0) {
          // Insert into DLQ for forensic tracking and replay capability
          const { failedJobs } = require('@media-downloader/db');
          await tx.insert(failedJobs).values({
            originalJobId: currentJob.id,
            queueName: queueName,
            platform: currentJob.platform,
            failedReason: failedReason,
            attemptsMade: job.attemptsMade || 0,
            jobData: job.data,
            failedAt: new Date()
          });

          await tx.update(users)
            .set({ activeJobs: sql`${users.activeJobs} - 1` })
            .where(sql`${users.id} = ${currentJob.userId} AND ${users.activeJobs} > 0`);
            
          logger.info({ jobId, queueName, failedReason }, 'Job marked FAILED_PERMANENTLY and quota released');
          
          if (currentJob.chatId && currentJob.statusMessageId) {
            const tgUrl = `https://api.telegram.org/bot${config.BOT_TOKEN}/editMessageText`;
            fetch(tgUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                chat_id: currentJob.chatId,
                message_id: currentJob.statusMessageId,
                text: '❌ Failed to process request.\n(Could not find any media, or the link is private)'
              })
            }).catch(e => logger.error({ err: e }, 'Failed to send failure notification to Telegram'));
          }
        }
      } else {
        await tx.update(jobs)
          .set({ status: JobStatus.RETRY_PENDING, error: failedReason, updatedAt: new Date() })
          .where(eq(jobs.id, jobId));
      }
    });
  } catch (err) {
    logger.error({ err, jobId, queueName }, 'Failed to handle terminal failure event');
  }
}

export async function setupTerminalFailureHandler() {
  const connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
  const allQueues = [...Object.values(QUEUES.DOWNLOAD), QUEUES.PROCESS, QUEUES.UPLOAD];

  for (const queueName of allQueues) {
    const queueEvents = new QueueEvents(queueName, { connection });
    const queue = new Queue(queueName, { connection });

    queueEvents.on('failed', async ({ jobId, failedReason }) => {
      if (!jobId) return;
      await handleTerminalFailure(jobId, failedReason, queueName, queue);
    });
  }
}

async function startPublisher() {
  logger.info('Starting PostgreSQL Outbox Publisher and Terminal Failure Handler');
  
  await setupTerminalFailureHandler();
  
  // Continuous polling
  setInterval(() => {
    processPendingEvents().catch(err => {
      logger.error({ err }, 'Unhandled error in processPendingEvents');
    });
  }, 1000);

  // Recovery polling
  setInterval(() => {
    recoverStuckEvents().catch(err => {
      logger.error({ err }, 'Unhandled error in recoverStuckEvents');
    });
  }, 5000);
}

// Start if executed directly
if (require.main === module) {
  startPublisher();
}

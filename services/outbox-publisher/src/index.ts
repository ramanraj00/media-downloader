import { db, outboxEvents, jobs, users } from '@media-downloader/db';
import { OutboxEventType, DownloadJobData, QUEUES, JobStatus } from '@media-downloader/types';
import { eq, and, lte, sql } from 'drizzle-orm';
import { enqueueDownloadJob } from '../../../apps/api/src/services/queueService';
import { createLogger } from '@media-downloader/logger';
import { QueueEvents, Queue } from 'bullmq';
import Redis from 'ioredis';
import { config } from '@media-downloader/config';

const logger = createLogger('outbox-publisher');

async function processPendingEvents() {
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
      } else {
        throw new Error(`Unimplemented event type: ${claimedEvent.eventType}`);
      }



      // 3. Mark as published in a new short update
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
      const delayMs = Math.pow(2, claimedEvent.attempts) * 1000;
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

async function setupTerminalFailureHandler() {
  const connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
  const allQueues = [...Object.values(QUEUES.DOWNLOAD), QUEUES.PROCESS, QUEUES.UPLOAD];

  for (const queueName of allQueues) {
    const queueEvents = new QueueEvents(queueName, { connection });
    const queue = new Queue(queueName, { connection });

    queueEvents.on('failed', async ({ jobId, failedReason }) => {
      if (!jobId) return;
      try {
        const job = await queue.getJob(jobId);
        if (!job) return;

        // Job is terminal if its state in Redis is 'failed'.
        // If it is going to retry, its state will be 'delayed' or 'waiting'.
        const state = await job.getState();
        const isTerminal = state === 'failed';

        const currentJob = await db.query.jobs.findFirst({ where: eq(jobs.id, jobId) });
        if (!currentJob) return;

        await db.transaction(async (tx) => {
          if (isTerminal) {
            // Idempotency: skip if already terminal
            if (currentJob.status === JobStatus.FAILED_PERMANENTLY || currentJob.status === JobStatus.COMPLETED) {
              logger.info({ jobId }, 'Job already terminal. Idempotency guard triggered.');
              return;
            }

            // TELEGRAM_UPLOADED cannot fail permanently
            if (currentJob.status === JobStatus.TELEGRAM_UPLOADED) {
              logger.warn({ jobId }, 'Terminal failure for TELEGRAM_UPLOADED job. Ignored FAILED_PERMANENTLY transition.');
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
                
              logger.info({ jobId, queueName, failedReason }, 'Job marked FAILED_PERMANENTLY and quota released');
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

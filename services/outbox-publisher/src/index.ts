import { db, outboxEvents } from '@media-downloader/db';
import { OutboxEventType, DownloadJobData } from '@media-downloader/types';
import { eq, and, lte } from 'drizzle-orm';
import { enqueueDownloadJob } from '../../../apps/api/src/services/queueService';
import { createLogger } from '@media-downloader/logger';

const logger = createLogger('outbox-publisher');

async function processPendingEvents() {
  try {
    // 1. Claim a pending event in a short transaction
    const claimedEvent = await db.transaction(async (tx) => {
      const events = await tx
        .select()
        .from(outboxEvents)
        .where(
          and(
            eq(outboxEvents.status, 'pending'),
            lte(outboxEvents.availableAt, new Date())
          )
        )
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

async function startPublisher() {
  logger.info('Starting PostgreSQL Outbox Publisher');
  
  // Continuous polling
  setInterval(() => {
    processPendingEvents().catch(err => {
      logger.error({ err }, 'Unhandled error in processPendingEvents');
    });
  }, 1000);
}

// Start if executed directly
if (require.main === module) {
  startPublisher();
}

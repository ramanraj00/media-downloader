import { Worker, Job as BullJob } from 'bullmq';
import Redis from 'ioredis';
import { config } from '@media-downloader/config';
import { Logger } from 'pino';
import { withJobContext } from '@media-downloader/logger';
import { QUEUES, UploadJobData, JobStatus } from '@media-downloader/types';
import { db, jobs, users, media } from '@media-downloader/db';
import { eq, sql } from 'drizzle-orm';
import { uploadToTelegram } from './uploader';
import { S3Storage } from '@media-downloader/core';
import fs from 'fs';
import path from 'path';

const s3 = new S3Storage();

export async function setupWorker(logger: Logger) {
  const connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });

  const worker = new Worker<UploadJobData>(
    QUEUES.UPLOAD,
    async (bullJob: BullJob<UploadJobData>) => {
      const jobLogger = withJobContext(logger, bullJob.data.jobId, 'upload');
      jobLogger.info('Received upload job');
      
      const localPath = path.join(config.TEMP_DIR, `job_${bullJob.data.jobId}_delivery.mp4`);

      try {
        const jobRecord = await db.query.jobs.findFirst({
          where: eq(jobs.id, bullJob.data.jobId)
        });

        if (!jobRecord) throw new Error('Job record not found');
        
        let currentStatus = jobRecord.status as JobStatus;

        if (currentStatus === JobStatus.COMPLETED || currentStatus === JobStatus.FAILED_PERMANENTLY) {
          jobLogger.info({ status: currentStatus }, 'Job already in terminal state, skipping upload');
          return;
        }

        if (currentStatus === JobStatus.UPLOADING || currentStatus === JobStatus.VALIDATING) {
          // Download artifact from S3
          jobLogger.info('Downloading processed artifact from S3 for delivery');
          await s3.getArtifact(bullJob.data.processedArtifact, localPath);

          // Upload to Telegram
          const { fileId, messageId } = await uploadToTelegram(bullJob.data, localPath, jobRecord, jobLogger);
          
          // Immediately persist durable identifiers and update state
          await db.update(jobs)
            .set({ 
              status: JobStatus.TELEGRAM_UPLOADED,
              telegramFileId: fileId,
              telegramMessageId: messageId,
              updatedAt: new Date() 
            })
            .where(eq(jobs.id, bullJob.data.jobId));
            
          currentStatus = JobStatus.TELEGRAM_UPLOADED;
          jobRecord.telegramFileId = fileId;
          jobRecord.telegramMessageId = messageId;
        }

        if (currentStatus === JobStatus.TELEGRAM_UPLOADED) {
          // Atomic finalization transaction
          await db.transaction(async (tx) => {
            // 1. Insert media idempotently
            await tx.insert(media).values({
              jobId: jobRecord.id,
              contentHash: bullJob.data.processedArtifact.contentHash,
              fileSize: bullJob.data.processedArtifact.sizeBytes,
            }).onConflictDoNothing({ target: media.jobId });
            
            // 2. Mark completed
            await tx.update(jobs)
              .set({ 
                status: JobStatus.COMPLETED, 
                completedAt: new Date(),
                updatedAt: new Date() 
              })
              .where(eq(jobs.id, jobRecord.id));
              
            // 3. Decrement quota safely
            await tx.update(users)
              .set({ activeJobs: sql`${users.activeJobs} - 1` })
              .where(sql`${users.id} = ${jobRecord.userId} AND ${users.activeJobs} > 0`);
              
            // 4. Create outbox event for reliable notification
            const { outboxEvents } = require('@media-downloader/db');
            await tx.insert(outboxEvents).values({
              eventType: 'JOB_COMPLETED',
              aggregateId: jobRecord.id,
              payload: { 
                jobId: jobRecord.id, 
                chatId: jobRecord.chatId,
                statusMessageId: jobRecord.statusMessageId,
                telegramFileId: jobRecord.telegramFileId,
                telegramMessageId: jobRecord.telegramMessageId
              }
            });
          });
        }

        // Cleanup temp file
        try {
          fs.unlinkSync(localPath);
        } catch (e) {
          jobLogger.warn({ err: e }, 'Failed to cleanup temp file');
        }

        jobLogger.info('Upload completed successfully');
      } catch (error: any) {
        jobLogger.error({ err: error }, 'Upload job failed');
        // Do not blindly mark FAILED_PERMANENTLY here. Let BullMQ handle retries.
        throw error;
      }
    },
    { 
      connection, 
      concurrency: Math.max(1, Math.floor(config.GLOBAL_MAX_WORKERS / 2)) 
    }
  );

  return worker;
}

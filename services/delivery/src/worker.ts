import { Worker, Job as BullJob } from 'bullmq';
import Redis from 'ioredis';
import { config } from '@media-downloader/config';
import { Logger } from 'pino';
import { withJobContext } from '@media-downloader/logger';
import { QUEUES, UploadJobData, JobStatus } from '@media-downloader/types';
import { db, jobs, users, media } from '@media-downloader/db';
import { eq } from 'drizzle-orm';
import { uploadToTelegram } from './uploader';
import { calculateFileHash } from '@media-downloader/core';
import fs from 'fs';

export async function setupWorker(logger: Logger) {
  const connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });

  const worker = new Worker<UploadJobData>(
    QUEUES.UPLOAD,
    async (bullJob: BullJob<UploadJobData>) => {
      const jobLogger = withJobContext(logger, bullJob.data.jobId, 'upload');
      jobLogger.info('Received upload job');
      
      try {
        await db.update(jobs)
          .set({ status: JobStatus.UPLOADING, updatedAt: new Date() })
          .where(eq(jobs.id, bullJob.data.jobId));
        
        const jobRecord = await db.query.jobs.findFirst({
          where: eq(jobs.id, bullJob.data.jobId)
        });

        if (!jobRecord) throw new Error('Job record not found');
        
        // Upload
        const fileId = await uploadToTelegram(bullJob.data, jobRecord, jobLogger);
        
        // Calculate hash and save media record
        const contentHash = await calculateFileHash(bullJob.data.processedPath);
        const stat = fs.statSync(bullJob.data.processedPath);
        
        await db.insert(media).values({
          jobId: jobRecord.id,
          contentHash,
          fileSize: stat.size,
        });
        
        // Final updates
        await db.update(jobs)
          .set({ 
            status: JobStatus.COMPLETED, 
            telegramFileId: fileId,
            completedAt: new Date(),
            updatedAt: new Date() 
          })
          .where(eq(jobs.id, jobRecord.id));
          
        // Free user's active slot
        const user = await db.query.users.findFirst({
          where: eq(users.id, jobRecord.userId)
        });
        
        if (user && user.activeJobs > 0) {
          await db.update(users)
            .set({ activeJobs: user.activeJobs - 1 })
            .where(eq(users.id, user.id));
        }

        // Cleanup temp file
        try {
          fs.unlinkSync(bullJob.data.processedPath);
        } catch (e) {
          jobLogger.warn({ err: e }, 'Failed to cleanup temp file');
        }

        jobLogger.info('Upload completed successfully');
      } catch (error: any) {
        jobLogger.error({ err: error }, 'Upload job failed');
        
        await db.update(jobs)
          .set({ 
            status: JobStatus.FAILED_PERMANENTLY, 
            error: error.message,
            updatedAt: new Date() 
          })
          .where(eq(jobs.id, bullJob.data.jobId));
          
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

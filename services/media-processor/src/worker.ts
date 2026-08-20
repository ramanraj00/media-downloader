import { Worker, Job as BullJob, Queue } from 'bullmq';
import Redis from 'ioredis';
import { config } from '@media-downloader/config';
import { Logger } from 'pino';
import { withJobContext } from '@media-downloader/logger';
import { QUEUES, ProcessJobData, JobStatus, UploadJobData } from '@media-downloader/types';
import { db, jobs } from '@media-downloader/db';
import { eq } from 'drizzle-orm';
import { normalizeVideo } from './ffmpeg';
import { calculateFileHash } from '@media-downloader/core';

export async function setupWorker(logger: Logger) {
  const connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
  const uploadQueue = new Queue(QUEUES.UPLOAD, { connection });

  const worker = new Worker<ProcessJobData>(
    QUEUES.PROCESS,
    async (bullJob: BullJob<ProcessJobData>) => {
      const jobLogger = withJobContext(logger, bullJob.data.jobId, 'process');
      jobLogger.info('Received process job');
      
      try {
        const jobRecord = await db.query.jobs.findFirst({
          where: eq(jobs.id, bullJob.data.jobId)
        });
        if (!jobRecord) throw new Error('Job record not found');
        if (jobRecord.status === JobStatus.COMPLETED || jobRecord.status === JobStatus.FAILED_PERMANENTLY) {
          jobLogger.info({ status: jobRecord.status }, 'Job already in terminal state, skipping processing');
          return;
        }

        await db.update(jobs)
          .set({ status: JobStatus.PROCESSING_MEDIA, updatedAt: new Date() })
          .where(eq(jobs.id, bullJob.data.jobId));
        
        // Process media
        const result = await normalizeVideo(bullJob.data.downloadPath, jobLogger);
        
        // Update status
        await db.update(jobs)
          .set({ status: JobStatus.VALIDATING, updatedAt: new Date() })
          .where(eq(jobs.id, bullJob.data.jobId));
        
        // Calculate file hash for finalization
        const contentHash = await calculateFileHash(result.filePath);
        
        // Enqueue to telegram:upload
        const uploadData: UploadJobData = {
          jobId: bullJob.data.jobId,
          processedPath: result.filePath,
          mediaType: result.mediaType,
          contentHash,
          fileSize: result.fileSize
        };
        
        await uploadQueue.add('upload', uploadData, {
          jobId: bullJob.data.jobId,
          removeOnComplete: true,
        });
        
        jobLogger.info('Media processing completed and queued for upload');
        return result;
      } catch (error: any) {
        jobLogger.error({ err: error }, 'Process job failed');
        
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

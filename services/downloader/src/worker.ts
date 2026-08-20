import { Worker, Job as BullJob, Queue } from 'bullmq';
import Redis from 'ioredis';
import { config } from '@media-downloader/config';
import { Logger } from 'pino';
import { withJobContext } from '@media-downloader/logger';
import { QUEUES, DownloadJobData, JobStatus, ProcessJobData } from '@media-downloader/types';
import { users, jobs, db } from '@media-downloader/db';
import { eq, sql } from 'drizzle-orm';
import { processDownload } from './engine';

export async function setupWorkers(logger: Logger) {
  const connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
  const processQueue = new Queue(QUEUES.PROCESS, { connection });

  const workerHandler = async (bullJob: BullJob<DownloadJobData>) => {
    const jobLogger = withJobContext(logger, bullJob.data.jobId, bullJob.data.platform);
    jobLogger.info('Received download job');
    
    try {
      const jobRecord = await db.query.jobs.findFirst({
        where: eq(jobs.id, bullJob.data.jobId)
      });
      if (!jobRecord) throw new Error('Job record not found');
      if (jobRecord.status === JobStatus.COMPLETED || jobRecord.status === JobStatus.FAILED_PERMANENTLY) {
        jobLogger.info({ status: jobRecord.status }, 'Job already in terminal state, skipping download');
        return;
      }

      // 1. Update job status to DOWNLOADING
      await db.update(jobs)
        .set({ status: JobStatus.DOWNLOADING, updatedAt: new Date() })
        .where(eq(jobs.id, bullJob.data.jobId));
      
      // 2. Perform download
      const result = await processDownload(bullJob.data, jobLogger);
      
      // 3. Update job status to PROCESSING_MEDIA
      await db.update(jobs)
        .set({ status: JobStatus.PROCESSING_MEDIA, updatedAt: new Date() })
        .where(eq(jobs.id, bullJob.data.jobId));
      
      // 4. Enqueue to media:process
      const processData: ProcessJobData = {
        jobId: bullJob.data.jobId,
        downloadPath: result.filePath,
      };
      
      await processQueue.add('process', processData, {
        jobId: bullJob.data.jobId,
        removeOnComplete: true,
      });
      
      jobLogger.info({ downloadTimeMs: result.downloadTimeMs }, 'Download completed and queued for processing');
      
      return result;
    } catch (error: any) {
      jobLogger.error({ err: error }, 'Download job failed');
      
      if (error.isRetryable === false) {
        const { UnrecoverableError } = require('bullmq');
        throw new UnrecoverableError(error.message);
      }
        
      throw error; // Let BullMQ handle retry if transient
    }
  };

  // Setup one worker per platform queue with specific concurrency limits
  const workers = [
    new Worker(QUEUES.DOWNLOAD.INSTAGRAM, workerHandler, { 
      connection, 
      concurrency: config.PLATFORM_CONCURRENCY_INSTAGRAM 
    }),
    new Worker(QUEUES.DOWNLOAD.TWITTER, workerHandler, { 
      connection, 
      concurrency: config.PLATFORM_CONCURRENCY_TWITTER 
    }),
    new Worker(QUEUES.DOWNLOAD.TIKTOK, workerHandler, { 
      connection, 
      concurrency: config.PLATFORM_CONCURRENCY_TIKTOK 
    }),
    new Worker(QUEUES.DOWNLOAD.REDDIT, workerHandler, { 
      connection, 
      concurrency: config.PLATFORM_CONCURRENCY_REDDIT 
    }),
  ];

  return workers;
}

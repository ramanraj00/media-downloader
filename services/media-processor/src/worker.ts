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
import { runProbe, determineMediaType } from './probe';

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
        
        // Pre-flight probe
        const preFlightProbe = await runProbe(bullJob.data.downloadPath);
        const mediaType = determineMediaType(preFlightProbe);
        
        if (mediaType === 'document') {
          throw new Error('Pre-flight validation failed: Unsupported media format or corrupted file');
        }

        // Process media
        const result = await normalizeVideo(bullJob.data.downloadPath, preFlightProbe, mediaType, jobLogger);
        
        // Update status to VALIDATING
        await db.update(jobs)
          .set({ status: JobStatus.VALIDATING, updatedAt: new Date() })
          .where(eq(jobs.id, bullJob.data.jobId));
          
        // Post-flight probe & Output Validation
        const postFlightProbe = await runProbe(result.filePath);
        
        if (postFlightProbe.fileSize === 0) {
          throw new Error('Output validation failed: File is 0 bytes');
        }
        if (postFlightProbe.fileSize > 50 * 1024 * 1024) {
          const sizeMB = (postFlightProbe.fileSize / (1024 * 1024)).toFixed(2);
          throw Object.assign(new Error(`File size ${sizeMB}MB exceeds Telegram's 50MB bot upload limit`), { isRetryable: false });
        }
        if (mediaType === 'video') {
          if (!postFlightProbe.hasVideo) {
            throw new Error('Output validation failed: Expected video stream but none found');
          }
          if (postFlightProbe.videoCodec !== 'h264') {
            throw new Error(`Output validation failed: Expected canonical H.264 video, got ${postFlightProbe.videoCodec}`);
          }
        }
        if (result.hasAudio) {
          if (!postFlightProbe.hasAudio) {
            throw new Error('Output validation failed: Expected audio stream but none found');
          }
          if (postFlightProbe.audioCodec !== 'aac') {
            throw new Error(`Output validation failed: Expected canonical AAC audio, got ${postFlightProbe.audioCodec}`);
          }
        }
        if (postFlightProbe.durationMismatch) {
          throw new Error(`Output validation failed: Duration mismatch is still present (Video: ${postFlightProbe.videoDuration}s, Audio: ${postFlightProbe.audioDuration}s).`);
        }
        
        const postAudioCount = postFlightProbe.streams.filter((s: any) => s.codec_type === 'audio').length;
        if (result.hasAudio && postAudioCount > 1) {
          throw new Error(`Output validation failed: Multiple audio tracks are still present (${postAudioCount}). Expected exactly 1.`);
        }

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
        
        jobLogger.info('Media processing & validation completed and queued for upload');
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

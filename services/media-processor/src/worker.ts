import { Worker, Job as BullJob, Queue } from 'bullmq';
import Redis from 'ioredis';
import { config } from '@media-downloader/config';
import { Logger } from 'pino';
import { withJobContext } from '@media-downloader/logger';
import { QUEUES, ProcessJobData, JobStatus, UploadJobData } from '@media-downloader/types';
import { users, jobs, db } from '@media-downloader/db';
import { eq, sql } from 'drizzle-orm';
import { normalizeVideo } from './ffmpeg';
import { calculateFileHash, LocalArtifactStorage } from '@media-downloader/core';
import { runProbe, determineMediaType } from './probe';
import fs from 'fs/promises';
import path from 'path';

const s3 = new LocalArtifactStorage();

export async function setupWorker(logger: Logger) {
  const connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
  const uploadQueue = new Queue(QUEUES.UPLOAD, { connection });

  const worker = new Worker<ProcessJobData>(
    QUEUES.PROCESS,
    async (bullJob: BullJob<ProcessJobData>) => {
      const jobLogger = withJobContext(logger, bullJob.data.jobId, 'process');
      jobLogger.info('Received process job');
      
      const originalExt = require('path').extname(bullJob.data.rawArtifact.objectKey) || '.mp4';
      const inputPath = path.join(config.TEMP_DIR, `job_${bullJob.data.jobId}_raw${originalExt}`);

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
        
        // 1. Download artifact from S3 (includes integrity check)
        jobLogger.info('Downloading artifact from S3');
        await s3.getArtifact(bullJob.data.rawArtifact, inputPath);

        // Pre-flight probe
        const preFlightProbe = await runProbe(inputPath);
        const mediaType = determineMediaType(preFlightProbe);
        
        if (mediaType === 'document') {
          throw new Error('Pre-flight validation failed: Unsupported media format or corrupted file');
        }

        // Process media
        const result = await normalizeVideo(inputPath, preFlightProbe, mediaType, jobLogger);
        
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
          if (postFlightProbe.videoCodec !== 'h264' && postFlightProbe.videoCodec !== 'hevc' && postFlightProbe.videoCodec !== 'h265') {
            throw new Error(`Output validation failed: Expected canonical H.264/HEVC video, got ${postFlightProbe.videoCodec}`);
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
        
        // Extract thumbnail
        let thumbArtifactRef;
        if (mediaType === 'video') {
          jobLogger.info('Extracting thumbnail');
          const thumbPath = `/tmp/${bullJob.data.jobId}_thumb.jpg`;
          try {
            // try to extract at 1s, fallback to 0s
            const execAsync = require('util').promisify(require('child_process').exec);
            try {
              await execAsync(`ffmpeg -y -ss 00:00:01 -i "${result.filePath}" -vframes 1 -vf "scale='min(320,iw)':'min(320,ih)':force_original_aspect_ratio=decrease" -q:v 2 "${thumbPath}"`);
            } catch(e) {
              await execAsync(`ffmpeg -y -i "${result.filePath}" -vframes 1 -vf "scale='min(320,iw)':'min(320,ih)':force_original_aspect_ratio=decrease" -q:v 2 "${thumbPath}"`);
            }
            if (require('fs').existsSync(thumbPath)) {
               const thumbKey = `jobs/${bullJob.data.jobId}/processed/thumb.jpg`;
               thumbArtifactRef = await s3.putArtifact(config.ARTIFACT_BUCKET, thumbKey, thumbPath);
               require('fs').unlinkSync(thumbPath);
            }
          } catch(e) {
            jobLogger.warn({ err: e }, 'Failed to extract thumbnail');
          }
        }
        
        // 2. Upload Processed Artifact to S3
        jobLogger.info('Uploading processed artifact to S3');
        const ext = require("path").extname(result.filePath) || ".mp4";
        const objectKey = `jobs/${bullJob.data.jobId}/processed/media${ext}`;
        const processedArtifactRef = await s3.putArtifact(config.ARTIFACT_BUCKET, objectKey, result.filePath);
        result.s3Artifact = processedArtifactRef;

        await db.update(jobs)
          .set({
            status: JobStatus.UPLOADING,
            contentHash,
            fileSize: result.fileSize,
            updatedAt: new Date()
          })
          .where(eq(jobs.id, bullJob.data.jobId));
        
        // Enqueue to telegram:upload
        const uploadData = {
          jobId: bullJob.data.jobId,
          processedArtifact: processedArtifactRef,
          thumbArtifact: thumbArtifactRef,
          width: postFlightProbe.width,
          height: postFlightProbe.height,
          duration: postFlightProbe.duration,
        };
        
        await uploadQueue.add('upload', uploadData, {
          jobId: bullJob.data.jobId,
          removeOnComplete: true,
        });
        
        jobLogger.info('Media processing & validation completed and queued for upload');

        // Cleanup local ephemeral disk
        try {
          await fs.unlink(inputPath);
          await fs.unlink(result.filePath);
        } catch (e) {
          // ignore
        }

        return result;
      } catch (error: any) {
        jobLogger.error({ err: error }, 'Process job failed');
        
        if (error.isRetryable === false) {
          const { UnrecoverableError } = require('bullmq');
          throw new UnrecoverableError(error.message);
        }
          
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

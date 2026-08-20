import { ProcessedMedia } from '@media-downloader/types';
import { Logger } from 'pino';
import { exec } from 'child_process';
import util from 'util';
import path from 'path';
import fs from 'fs';
import { config } from '@media-downloader/config';

const execAsync = util.promisify(exec);

export async function normalizeVideo(inputPath: string, logger: Logger): Promise<ProcessedMedia> {
  if (!fs.existsSync(inputPath)) {
    throw new Error(`Input file not found: ${inputPath}`);
  }

  const stat = fs.statSync(inputPath);
  const ext = path.extname(inputPath).toLowerCase();
  
  if (['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) {
    logger.info('File is image, skipping video processing');
    return {
      filePath: inputPath,
      mediaType: 'photo',
      fileSize: stat.size,
      hasAudio: false,
      wasConverted: false,
    };
  }

  if (['.mp3', '.m4a', '.wav'].includes(ext)) {
    logger.info('File is audio, skipping video processing');
    return {
      filePath: inputPath,
      mediaType: 'audio',
      fileSize: stat.size,
      hasAudio: true,
      wasConverted: false,
    };
  }

  // File is video
  if (stat.size <= config.MAX_FILE_SIZE && ext === '.mp4') {
    // Fast path: valid mp4 under size limit, let's just make sure it's streamable (faststart)
    const outputPath = inputPath.replace(ext, '_faststart.mp4');
    
    try {
      logger.info('Applying faststart to valid MP4');
      await execAsync(`ffmpeg -y -i "${inputPath}" -c copy -movflags +faststart "${outputPath}"`);
      
      // Cleanup original
      fs.unlinkSync(inputPath);
      
      return {
        filePath: outputPath,
        mediaType: 'video',
        fileSize: fs.statSync(outputPath).size,
        hasAudio: true, // simplified
        wasConverted: false, // We just copied streams
      };
    } catch (err) {
      logger.warn({ err }, 'Faststart failed, falling back to full transcode');
      // Continue to full transcode
    }
  }

  // Full transcode required (either > 50MB, not mp4, or faststart failed)
  const outputPath = inputPath.replace(ext, '_processed.mp4');
  
  logger.info('Transcoding video to MP4/H.264/AAC');
  
  // Basic compression for Telegram limits
  let videoBitrate = '2M';
  if (stat.size > config.MAX_FILE_SIZE * 2) {
    videoBitrate = '1M';
  }

  const cmd = `ffmpeg -y -i "${inputPath}" -c:v libx264 -preset medium -b:v ${videoBitrate} -pass 1 -an -f mp4 /dev/null && ffmpeg -y -i "${inputPath}" -c:v libx264 -preset medium -b:v ${videoBitrate} -pass 2 -c:a aac -b:a 128k -movflags +faststart "${outputPath}"`;
  
  try {
    // Note: In real production, you'd use a better wrapper like fluent-ffmpeg, 
    // but exec works for this implementation
    await execAsync(cmd);
    
    // Clean up pass log files and original
    try {
      fs.unlinkSync('ffmpeg2pass-0.log');
      fs.unlinkSync('ffmpeg2pass-0.log.mbtree');
      fs.unlinkSync(inputPath);
    } catch (e) {}

    return {
      filePath: outputPath,
      mediaType: 'video',
      fileSize: fs.statSync(outputPath).size,
      hasAudio: true,
      wasConverted: true,
    };
  } catch (error: any) {
    throw new Error(`FFmpeg processing failed: ${error.message}`);
  }
}

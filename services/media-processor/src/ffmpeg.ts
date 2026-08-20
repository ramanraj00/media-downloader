import { ProcessedMedia, ProbeResult } from '@media-downloader/types';
import { Logger } from 'pino';
import { exec } from 'child_process';
import util from 'util';
import path from 'path';
import fs from 'fs';
import { config } from '@media-downloader/config';

const execAsync = util.promisify(exec);

export async function normalizeVideo(
  inputPath: string, 
  probe: ProbeResult, 
  mediaType: 'video' | 'audio' | 'photo' | 'document', 
  logger: Logger
): Promise<ProcessedMedia> {
  if (!fs.existsSync(inputPath)) {
    throw new Error(`Input file not found: ${inputPath}`);
  }

  const ext = path.extname(inputPath).toLowerCase();

  if (mediaType === 'document') {
    throw new Error('Cannot process unsupported document type');
  }

  if (mediaType === 'photo') {
    logger.info('File is photo, skipping video processing');
    return {
      filePath: inputPath,
      mediaType,
      fileSize: probe.fileSize,
      hasAudio: false,
      wasConverted: false,
    };
  }

  // Audio track selection policy
  let selectedAudio = undefined;
  if (probe.hasAudio) {
    const audioStreams = probe.streams.filter(s => s.codec_type === 'audio');
    selectedAudio = audioStreams.find(s => s.isDefault) || audioStreams[0];
    logger.info({
      globalIndex: selectedAudio.index,
      audioIndex: selectedAudio.codecTypeIndex,
      isDefault: selectedAudio.isDefault,
      codec: selectedAudio.codec_name
    }, 'Selected audio stream');
  }

  if (mediaType === 'audio') {
    logger.info('File is audio, stripping video and enforcing AAC');
    const outputPath = inputPath.replace(ext, '_processed.m4a');
    let mapArgs = selectedAudio ? `-map 0:a:${selectedAudio.codecTypeIndex}` : '-vn';
    const cmd = `ffmpeg -y -i "${inputPath}" ${mapArgs} -c:a aac "${outputPath}"`;
    
    logger.info({ cmd }, 'Executing FFmpeg command');
    await execAsync(cmd);
    fs.unlinkSync(inputPath);
    
    return {
      filePath: outputPath,
      mediaType: 'audio',
      fileSize: fs.statSync(outputPath).size,
      hasAudio: true,
      wasConverted: true,
    };
  }

  // File is video
  let mapArgs = `-map 0:v:0`;
  if (selectedAudio) {
    mapArgs += ` -map 0:a:${selectedAudio.codecTypeIndex}`;
  }

  let filterArgs = '';
  if (probe.durationMismatch && selectedAudio) {
    filterArgs = `-af apad -shortest`;
    logger.info('Duration mismatch detected. Applying apad + shortest filters.');
  }

  const isMp4 = probe.container?.includes('mp4') || ext === '.mp4';
  const isH264 = probe.videoCodec === 'h264';
  const isAac = !selectedAudio || selectedAudio.codec_name === 'aac';
  const isUnderSize = probe.fileSize <= config.MAX_FILE_SIZE;
  const isCompatible = isMp4 && isH264 && isAac && isUnderSize && !probe.durationMismatch;

  if (isCompatible) {
    const outputPath = inputPath.replace(ext, '_faststart.mp4');
    try {
      logger.info('Video is canonical (H264/AAC/MP4). Applying copy + faststart.');
      const cmd = `ffmpeg -y -i "${inputPath}" ${mapArgs} -c copy -movflags +faststart "${outputPath}"`;
      logger.info({ cmd }, 'Executing FFmpeg command');
      await execAsync(cmd);
      fs.unlinkSync(inputPath);
      return {
        filePath: outputPath,
        mediaType: 'video',
        fileSize: fs.statSync(outputPath).size,
        hasAudio: !!selectedAudio,
        wasConverted: false,
      };
    } catch (err) {
      logger.warn({ err }, 'Faststart copy failed, falling back to full transcode');
    }
  }

  // Full transcode required
  const outputPath = inputPath.replace(ext, '_processed.mp4');
  logger.info('Transcoding video to MP4/H.264/AAC');
  
  let videoBitrate = probe.fileSize > config.MAX_FILE_SIZE * 2 ? '1M' : '2M';
  const audioCodecStr = selectedAudio ? `-c:a aac -b:a 128k ${filterArgs}` : '';

  const cmd = `ffmpeg -y -i "${inputPath}" ${mapArgs} -c:v libx264 -preset medium -b:v ${videoBitrate} -pass 1 -an -f mp4 /dev/null && ffmpeg -y -i "${inputPath}" ${mapArgs} -c:v libx264 -preset medium -b:v ${videoBitrate} -pass 2 ${audioCodecStr} -movflags +faststart "${outputPath}"`;
  
  try {
    logger.info({ cmd }, 'Executing FFmpeg command');
    await execAsync(cmd);
    
    try {
      fs.unlinkSync('ffmpeg2pass-0.log');
      fs.unlinkSync('ffmpeg2pass-0.log.mbtree');
      fs.unlinkSync(inputPath);
    } catch (e) {}

    return {
      filePath: outputPath,
      mediaType: 'video',
      fileSize: fs.statSync(outputPath).size,
      hasAudio: !!selectedAudio,
      wasConverted: true,
    };
  } catch (error: any) {
    throw new Error(`FFmpeg processing failed: ${error.message}`);
  }
}

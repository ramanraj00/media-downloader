import { ProbeResult, ProbeStream } from '@media-downloader/types';
import { exec } from 'child_process';
import util from 'util';
import fs from 'fs';

const execAsync = util.promisify(exec);

export async function runProbe(filePath: string): Promise<ProbeResult> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Probe failed: File does not exist - ${filePath}`);
  }
  
  const stat = fs.statSync(filePath);
  if (stat.size === 0) {
    throw new Error(`Probe failed: File is 0 bytes - ${filePath}`);
  }

  const cmd = `ffprobe -v quiet -print_format json -show_format -show_streams "${filePath}"`;
  
  try {
    const { stdout } = await execAsync(cmd);
    const data = JSON.parse(stdout);
    
    let videoIndexCount = 0;
    let audioIndexCount = 0;

    const streams: ProbeStream[] = (data.streams || []).map((s: any) => {
      let codecTypeIndex = undefined;
      if (s.codec_type === 'video') codecTypeIndex = videoIndexCount++;
      if (s.codec_type === 'audio') codecTypeIndex = audioIndexCount++;
      
      return {
        index: s.index,
        codec_type: s.codec_type,
        codec_name: s.codec_name,
        width: s.width,
        height: s.height,
        duration: s.duration ? parseFloat(s.duration) : undefined,
        isDefault: s.disposition?.default === 1,
        codecTypeIndex,
      };
    });
    
    const videoStreams = streams.filter(s => s.codec_type === 'video');
    const audioStreams = streams.filter(s => s.codec_type === 'audio');
    
    const hasVideo = videoStreams.length > 0;
    const hasAudio = audioStreams.length > 0;
    
    const videoStream = videoStreams[0]; // Take first for metadata
    const audioStream = audioStreams[0];
    
    const videoDuration = videoStream?.duration;
    const audioDuration = audioStream?.duration;
    
    const formatDuration = data.format?.duration ? parseFloat(data.format.duration) : undefined;
    
    let durationMismatch = false;
    const DURATION_TOLERANCE = 0.25; // 250ms tolerance
    if (videoDuration !== undefined && audioDuration !== undefined) {
      if (Math.abs(videoDuration - audioDuration) > DURATION_TOLERANCE) {
        durationMismatch = true;
      }
    }

    return {
      hasVideo,
      hasAudio,
      videoCodec: videoStream?.codec_name,
      audioCodec: audioStream?.codec_name,
      duration: formatDuration,
      videoDuration,
      audioDuration,
      width: videoStream?.width,
      height: videoStream?.height,
      fileSize: stat.size,
      container: data.format?.format_name,
      streams,
      durationMismatch,
    };
  } catch (error: any) {
    throw new Error(`ffprobe execution failed: ${error.message}`);
  }
}

export function determineMediaType(probe: ProbeResult): 'video' | 'audio' | 'photo' | 'document' {
  if (probe.hasVideo && probe.videoCodec !== 'png' && probe.videoCodec !== 'mjpeg' && probe.videoCodec !== 'webp') {
    return 'video'; // Typical video
  }
  
  if (!probe.hasVideo && probe.hasAudio) {
    return 'audio'; // Audio only
  }
  
  if (probe.hasVideo && (probe.videoCodec === 'png' || probe.videoCodec === 'mjpeg' || probe.videoCodec === 'webp')) {
    return 'photo'; // Image
  }
  
  // If it has no audio, no video, or is something completely unrecognizable
  return 'document';
}

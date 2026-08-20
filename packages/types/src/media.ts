import { Platform } from './platform';

export interface MediaInfo {
  url: string;
  platform: Platform;
  title?: string;
  duration?: number;
  width?: number;
  height?: number;
  thumbnailUrl?: string;
  fileSize?: number;
  ext?: string;
  hasAudio?: boolean;
  hasVideo?: boolean;
  vcodec?: string;
  acodec?: string;
}

export interface DownloadResult {
  filePath: string;
  info: MediaInfo;
  sourceLayer: string; // 'anonymous', 'cookies', 'api_fallback'
  downloadTimeMs: number;
}

export interface ProcessedMedia {
  filePath: string;
  mediaType: 'video' | 'audio' | 'photo' | 'document';
  width?: number;
  height?: number;
  duration?: number;
  hasAudio: boolean;
  fileSize: number;
  wasConverted: boolean;
}

export interface ProbeStream {
  index: number;
  codec_type: string;
  codec_name?: string;
  width?: number;
  height?: number;
  duration?: number;
  isDefault?: boolean;
  codecTypeIndex?: number;
}

export interface ProbeResult {
  hasVideo: boolean;
  hasAudio: boolean;
  videoCodec?: string;
  audioCodec?: string;
  duration?: number;
  videoDuration?: number;
  audioDuration?: number;
  width?: number;
  height?: number;
  fileSize: number;
  container?: string;
  streams: ProbeStream[];
  durationMismatch: boolean;
}

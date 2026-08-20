export const QUEUES = {
  DOWNLOAD: {
    INSTAGRAM: 'download-instagram',
    TWITTER: 'download-twitter',
    TIKTOK: 'download-tiktok',
    REDDIT: 'download-reddit',
  },
  PROCESS: 'media-process',
  UPLOAD: 'telegram-upload',
} as const;

export interface DownloadJobData {
  jobId: string;
  url: string;
  urlHash: string;
  platform: string;
}

export interface ProcessJobData {
  jobId: string;
  downloadPath: string;
}

export interface UploadJobData {
  jobId: string;
  processedPath: string;
  mediaType: string;
  contentHash: string;
  fileSize: number;
}

export enum OutboxEventType {
  DOWNLOAD_REQUESTED = 'DOWNLOAD_REQUESTED',
  MEDIA_PROCESS_REQUESTED = 'MEDIA_PROCESS_REQUESTED',
  DELIVERY_REQUESTED = 'DELIVERY_REQUESTED',
}

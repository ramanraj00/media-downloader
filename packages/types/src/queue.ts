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

export interface S3ArtifactReference {
  bucket: string;
  objectKey: string;
  sizeBytes: number;
  contentType: string;
  contentHash: string; // SHA-256 for integrity
}

export interface ProcessJobData {
  jobId: string;
  rawArtifact: S3ArtifactReference;
}

export interface UploadJobData {
  jobId: string;
  processedArtifact: S3ArtifactReference;
}

export enum OutboxEventType {
  DOWNLOAD_REQUESTED = 'DOWNLOAD_REQUESTED',
  MEDIA_PROCESS_REQUESTED = 'MEDIA_PROCESS_REQUESTED',
  DELIVERY_REQUESTED = 'DELIVERY_REQUESTED',
  JOB_COMPLETED = 'JOB_COMPLETED',
}

export enum JobStatus {
  RECEIVED = 'received',
  VALIDATED = 'validated',
  QUEUED = 'queued',
  PROCESSING = 'processing',
  DOWNLOADING = 'downloading',
  PROCESSING_MEDIA = 'processing_media',
  VALIDATING = 'validating',
  UPLOADING = 'uploading',
  COMPLETED = 'completed',
  FAILED = 'failed',
  RETRY_PENDING = 'retry_pending',
  FAILED_PERMANENTLY = 'failed_permanently',
}

export const ALLOWED_TRANSITIONS: Record<JobStatus, JobStatus[]> = {
  [JobStatus.RECEIVED]: [JobStatus.VALIDATED, JobStatus.FAILED],
  [JobStatus.VALIDATED]: [JobStatus.QUEUED, JobStatus.FAILED],
  [JobStatus.QUEUED]: [JobStatus.PROCESSING],
  [JobStatus.PROCESSING]: [JobStatus.DOWNLOADING, JobStatus.FAILED],
  [JobStatus.DOWNLOADING]: [JobStatus.PROCESSING_MEDIA, JobStatus.FAILED],
  [JobStatus.PROCESSING_MEDIA]: [JobStatus.VALIDATING, JobStatus.FAILED],
  [JobStatus.VALIDATING]: [JobStatus.UPLOADING, JobStatus.FAILED],
  [JobStatus.UPLOADING]: [JobStatus.COMPLETED, JobStatus.FAILED],
  [JobStatus.FAILED]: [JobStatus.RETRY_PENDING, JobStatus.FAILED_PERMANENTLY],
  [JobStatus.RETRY_PENDING]: [JobStatus.QUEUED],
  [JobStatus.COMPLETED]: [],
  [JobStatus.FAILED_PERMANENTLY]: [],
};

export interface Job {
  id: string;
  userId: number;
  url: string;
  normalizedUrl: string;
  urlHash: string;
  platform: string;
  status: JobStatus;
  chatId: number;
  statusMessageId?: number;
  retryCount: number;
  error?: string;
  telegramFileId?: string;
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date;
}

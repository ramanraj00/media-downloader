export type ExtractionResult =
  | {
      status: 'success';
      source: 'cobalt' | 'ytdlp' | 'playwright' | 'other';
      mediaUrl?: string;
      filePath?: string;
      metadata?: Record<string, any>;
    }
  | {
      status: 'retryable';
      source: string;
      reason: string;
    }
  | {
      status: 'unsupported';
      source: string;
      reason: string;
    }
  | {
      status: 'auth_required';
      source: string;
      reason: string;
    };

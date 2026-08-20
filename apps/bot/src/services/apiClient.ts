import { config } from '@media-downloader/config';

interface SubmitJobPayload {
  url: string;
  userId: number;
  chatId: number;
  statusMessageId?: number;
}

interface SubmitJobResponse {
  jobId: string;
  status: string;
  isDuplicate: boolean;
  telegramFileId?: string;
}

export async function submitJobToApi(payload: SubmitJobPayload): Promise<SubmitJobResponse> {
  const response = await fetch(`${config.API_URL}/v1/jobs`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json();

  if (!response.ok) {
    const error = new Error(data.error || 'API Error');
    (error as any).response = { data };
    throw error;
  }

  return data as SubmitJobResponse;
}

import { DownloadResult, Platform } from '@media-downloader/types';
import { detectPlatform, TransientError } from '@media-downloader/core';
import { config } from '@media-downloader/config';
import fs from 'fs';
import path from 'path';

export class CobaltFallback {
  private apis: string[];
  private failedApis: Record<string, number> = {};
  private cooldownMs = 300000; // 5 minutes

  constructor(customApis?: string[]) {
    this.apis = customApis || [
      'https://api.cobalt.tools',
      'https://cobalt-api.kwiatekmateusz.pl',
      'https://cobalt.wuk.sh'
    ];
  }

  private getHealthyApis(): string[] {
    const now = Date.now();
    const healthy = this.apis.filter(api => {
      const failureTime = this.failedApis[api];
      if (failureTime && now - failureTime < this.cooldownMs) {
        return false; // Still in cooldown
      }
      if (failureTime) {
        delete this.failedApis[api]; // Cooldown expired
      }
      return true;
    });

    return healthy.length > 0 ? healthy : this.apis;
  }

  async download(url: string, outputDir: string): Promise<DownloadResult> {
    const healthyApis = this.getHealthyApis();
    let lastError: Error | null = null;

    for (const api of healthyApis) {
      try {
        return await this.tryApi(api, url, outputDir);
      } catch (error: any) {
        this.failedApis[api] = Date.now();
        lastError = error;
      }
    }

    throw new TransientError(`All Cobalt API fallbacks failed. Last error: ${lastError?.message}`);
  }

  private async tryApi(api: string, url: string, outputDir: string): Promise<DownloadResult> {
    const startTime = Date.now();
    const apiUrl = api.endsWith('/api/json') ? api : `${api}/api/json`;

    const payload = {
      url,
      vQuality: "1080",
      filenamePattern: "basic",
    };

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`API returned HTTP ${response.status}`);
    }

    const data = await response.json();

    if (data.status === 'error') {
      throw new Error(`Cobalt error: ${data.text}`);
    }

    let downloadUrl = data.url;
    if (data.status === 'picker' && data.picker && data.picker.length > 0) {
      downloadUrl = data.picker[0].url;
    }

    if (!downloadUrl) {
      throw new Error('No download URL returned from Cobalt');
    }

    // Download the actual file
    const fileResp = await fetch(downloadUrl);
    if (!fileResp.ok) throw new Error('Failed to fetch file from Cobalt URL');

    const ext = downloadUrl.includes('.mp3') ? 'mp3' : 'mp4';
    const filename = `cobalt_${Date.now()}.${ext}`;
    const actualPath = path.join(outputDir, filename);

    const buffer = Buffer.from(await fileResp.arrayBuffer());
    fs.writeFileSync(actualPath, buffer);

    if (buffer.length === 0) {
      throw new Error('Downloaded file is empty');
    }

    return {
      filePath: actualPath,
      info: {
        url,
        platform: detectPlatform(url) || Platform.UNKNOWN,
        fileSize: buffer.length,
        ext,
        hasAudio: true,
        hasVideo: ext !== 'mp3',
      },
      sourceLayer: 'cobalt',
      downloadTimeMs: Date.now() - startTime,
    };
  }
}

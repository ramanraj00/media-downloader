import { Platform } from '@media-downloader/types';
import { PlatformAdapter } from './adapter';
import { TransientError, PermanentError, AdmissionController } from '@media-downloader/core';
import { config } from '@media-downloader/config';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export class CobaltAdapter extends PlatformAdapter {
  platform = Platform.UNKNOWN;
  private admission: AdmissionController;

  constructor() {
    super();
    this.admission = new AdmissionController(config.REDIS_URL);
  }

  canHandle(url: string): boolean {
    return true; // Cobalt is the generic fallback
  }

  async extract(urlStr: string, outputDir: string, _creds?: string): Promise<import("@media-downloader/types").ExtractionResult> {
    const startTime = Date.now();
    const token = await this.admission.admit('cobalt', config.COBALT_ADMISSION_LIMIT, 300000);
    
    if (!token) {
      throw new TransientError('Cobalt admission limit reached (fallback congested)');
    }

    try {
      // 1. Call Cobalt API
      const response = await fetch(`${config.COBALT_URL}/`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          ...(config.COBALT_API_KEY ? { 'Authorization': `Api-Key ${config.COBALT_API_KEY}` } : {})
        },
        body: JSON.stringify({
          url: urlStr,
          vQuality: '1080',
          filenamePattern: 'classic'
        })
      });

      if (response.status === 429) {
        throw new TransientError('Cobalt Rate Limited');
      }
      
      if (!response.ok) {
        throw new PermanentError(`Cobalt returned ${response.status}`);
      }

      const data = await response.json();
      
      if (data.status === 'error') {
        throw new PermanentError(`Cobalt error: ${data.text}`);
      }

      const streamUrl = data.url;
      if (!streamUrl) {
        throw new PermanentError('Cobalt returned success but no URL');
      }

      // 2. Download the media
      const mediaResponse = await fetch(streamUrl);
      if (!mediaResponse.ok) {
        throw new TransientError(`Cobalt media stream returned ${mediaResponse.status}`);
      }

      const filePath = path.join(outputDir, `cobalt_${crypto.randomUUID()}.mp4`);
      const fileStream = fs.createWriteStream(filePath);
      
      if (mediaResponse.body) {
        // Node 18+ fetch body is a ReadableStream
        const { Readable } = require('stream');
        const { finished } = require('stream/promises');
        await finished(Readable.fromWeb(mediaResponse.body).pipe(fileStream));
      } else {
        throw new PermanentError('No body in Cobalt media response');
      }

      return {
        status: 'success',
        source: 'cobalt',
        filePath,
        metadata: { url: urlStr, platform: this.platform, ext: 'mp4', downloadTimeMs: Date.now() - startTime }
      };
    } catch (err: any) {
      if (err instanceof TransientError || err instanceof PermanentError) {
        throw err;
      }
      if (err.cause?.code === 'ECONNREFUSED' || err.code === 'ECONNREFUSED') {
        throw new TransientError('Cobalt service unreachable');
      }
      throw new TransientError(`Cobalt network error: ${err.message}`);
    } finally {
      await this.admission.release('cobalt', token);
    }
  }
}

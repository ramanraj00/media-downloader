import { Platform } from '@media-downloader/types';
import { PlatformAdapter } from './adapter';
import {
  TransientError,
  PermanentError,
  GeoBlockedError,
  DatacenterBlockedError,
  AuthRequiredError,
  AdmissionController
} from '@media-downloader/core';
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
          videoQuality: '1080'
        })
      });

      if (response.status === 429) {
        throw new TransientError('Cobalt Rate Limited');
      }

      const responseText = await response.text();
      let data: any;
      try {
        data = JSON.parse(responseText);
      } catch (e) {
        if (!response.ok) {
           throw new PermanentError(`Cobalt returned ${response.status}: ${responseText}`);
        }
      }
      
      if (!response.ok || data?.status === 'error') {
        const errorCode = data?.error?.code || '';
        const errorContext = data?.error?.context?.service || '';
        
        // Classify Cobalt-specific errors into typed errors
        this.classifyCobaltError(errorCode, errorContext, response.status, responseText);
      }

      const streamUrl = data?.url;
      if (!streamUrl) {
        throw new PermanentError('Cobalt returned success but no URL');
      }

      const filename = data?.filename || '';
      if (this.platform === 'instagram' && urlStr.includes('/reel/') && (filename.endsWith('.jpg') || filename.endsWith('.webp') || filename.endsWith('.png'))) {
        throw new AuthRequiredError('Cobalt returned a thumbnail instead of a reel video. Instagram login required.');
      }
      
      let ext = 'mp4';
      if (filename.includes('.')) {
         ext = filename.split('.').pop() || 'mp4';
      }

      // 2. Download the media
      const mediaResponse = await fetch(streamUrl);
      if (!mediaResponse.ok) {
        throw new TransientError(`Cobalt media stream returned ${mediaResponse.status}`);
      }

      const filePath = path.join(outputDir, `cobalt_${crypto.randomUUID()}.${ext}`);
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
        metadata: { url: urlStr, platform: this.platform, ext, downloadTimeMs: Date.now() - startTime }
      };
    } catch (err: any) {
      if (err instanceof TransientError || err instanceof PermanentError ||
          err instanceof GeoBlockedError || err instanceof DatacenterBlockedError) {
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

  /**
   * Classifies Cobalt error responses into typed errors.
   * Cobalt returns structured JSON errors like:
   *   { "status": "error", "error": { "code": "error.api.fetch.fail", "context": { "service": "tiktok" } } }
   */
  private classifyCobaltError(errorCode: string, contextService: string, httpStatus: number, rawText: string): never {
    // error.api.fetch.fail → The upstream platform rejected Cobalt's request.
    // This is typically a geo-block or datacenter IP block.
    if (errorCode === 'error.api.fetch.fail') {
      // TikTok from India → geo-block (India ban)
      if (contextService === 'tiktok') {
        throw new GeoBlockedError(
          `Cobalt: TikTok fetch failed (likely geo-blocked). Code: ${errorCode}`,
          'tiktok'
        );
      }
      // Reddit from AWS datacenter IP → datacenter block
      if (contextService === 'reddit') {
        throw new DatacenterBlockedError(
          `Cobalt: Reddit fetch failed (likely datacenter IP blocked). Code: ${errorCode}`,
          'reddit'
        );
      }
      // Generic platform fetch failure — treat as datacenter block by default
      throw new DatacenterBlockedError(
        `Cobalt: Fetch failed for service=${contextService}. Code: ${errorCode}`,
        contextService || undefined
      );
    }

    // error.api.content.video.unavailable → content genuinely unavailable
    if (errorCode.includes('content') && errorCode.includes('unavailable')) {
      throw new PermanentError(`Cobalt: Content unavailable. Code: ${errorCode}`);
    }

    // error.api.link.unsupported → URL not supported by Cobalt
    if (errorCode.includes('unsupported')) {
      throw new PermanentError(`Cobalt: Unsupported URL. Code: ${errorCode}`);
    }

    // error.api.invalid_body → bad payload (our bug, not platform's)
    if (errorCode === 'error.api.invalid_body') {
      throw new PermanentError(`Cobalt: Invalid request body. Code: ${errorCode}`);
    }

    // Fallback: unknown Cobalt error
    throw new PermanentError(`Cobalt returned ${httpStatus}: ${rawText}`);
  }
}

import { S3ArtifactReference } from '@media-downloader/types';
import fs from 'fs/promises';
import { createReadStream, createWriteStream } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';

export class S3Storage {
  private s3Client: S3Client;

  constructor() {
    this.s3Client = new S3Client({ region: 'ap-south-1' });
  }

  async init() {
    // S3 requires no local initialization
  }

  /**
   * Idempotent upload with SHA-256 generation.
   */
  async putArtifact(
    bucket: string,
    objectKey: string,
    localFilePath: string,
    contentType?: string
  ): Promise<S3ArtifactReference> {
    
    if (!contentType) {
      const ext = require('path').extname(objectKey).toLowerCase();
      if (['.jpg', '.jpeg'].includes(ext)) contentType = 'image/jpeg';
      else if (ext === '.png') contentType = 'image/png';
      else if (ext === '.webp') contentType = 'image/webp';
      else contentType = 'video/mp4';
    }

    // Read and calculate hash
    const data = await fs.readFile(localFilePath);
    const hashSum = crypto.createHash('sha256');
    hashSum.update(data);
    const contentHash = hashSum.digest('hex');

    // S3 PUT
    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: objectKey,
      Body: data,
      ContentType: contentType,
      Metadata: {
        'content-hash': contentHash
      }
    });

    await this.s3Client.send(command);

    return {
      bucket,
      objectKey,
      sizeBytes: data.length,
      contentType,
      contentHash,
    };
  }

  /**
   * Checkpoint / existence check
   */
  async artifactExists(bucket: string, objectKey: string): Promise<boolean> {
    try {
      const command = new HeadObjectCommand({ Bucket: bucket, Key: objectKey });
      await this.s3Client.send(command);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get artifact metadata without downloading
   */
  async getArtifactMetadata(bucket: string, objectKey: string): Promise<{ sizeBytes: number; contentHash: string }> {
    const command = new HeadObjectCommand({ Bucket: bucket, Key: objectKey });
    const response = await this.s3Client.send(command);
    return {
      sizeBytes: response.ContentLength || 0,
      contentHash: response.Metadata?.['content-hash'] || '',
    };
  }

  /**
   * Download and verify integrity
   */
  async getArtifact(
    ref: S3ArtifactReference,
    destinationPath: string
  ): Promise<void> {
    let response;
    try {
      const command = new GetObjectCommand({ Bucket: ref.bucket, Key: ref.objectKey });
      response = await this.s3Client.send(command);
    } catch (e: any) {
      throw new Error(`S3 Object not found: ${ref.bucket}/${ref.objectKey}`);
    }

    if (!response.Body) {
      throw new Error(`S3 Object body empty: ${ref.bucket}/${ref.objectKey}`);
    }

    await fs.mkdir(path.dirname(destinationPath), { recursive: true });

    // Stream download and verify hash
    const hashSum = crypto.createHash('sha256');
    const writeStream = createWriteStream(destinationPath);
    
    const body = response.Body as NodeJS.ReadableStream;
    
    return new Promise((resolve, reject) => {
        body.on('data', (chunk) => hashSum.update(chunk));
        body.pipe(writeStream)
            .on('finish', () => {
                const actualHash = hashSum.digest('hex');
                if (actualHash !== ref.contentHash) {
                    reject(new Error(`Integrity Error: Expected hash ${ref.contentHash}, got ${actualHash} for ${ref.objectKey}`));
                } else {
                    resolve();
                }
            })
            .on('error', reject);
    });
  }
}

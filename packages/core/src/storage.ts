import { S3ArtifactReference } from '@media-downloader/types';
import fs from 'fs/promises';
import { createReadStream, createWriteStream } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { Readable } from 'stream';

export class LocalArtifactStorage {
  private baseDir: string;

  constructor() {
    this.baseDir = process.env.ARTIFACTS_DIR || '/app/artifacts';
  }

  async init() {
    await fs.mkdir(this.baseDir, { recursive: true });
  }

  /**
   * Get the absolute path for an object key
   */
  private getPath(objectKey: string): string {
    return path.join(this.baseDir, objectKey);
  }

  /**
   * Idempotent upload with SHA-256 generation.
   */
  async putArtifact(
    bucket: string, // Kept for interface compatibility but ignored
    objectKey: string,
    localFilePath: string,
    contentType?: string
  ): Promise<S3ArtifactReference> {
    
    if (!contentType) {
      const ext = path.extname(objectKey).toLowerCase();
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

    const destPath = this.getPath(objectKey);
    await fs.mkdir(path.dirname(destPath), { recursive: true });
    await fs.copyFile(localFilePath, destPath);

    return {
      bucket: 'local',
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
      await fs.access(this.getPath(objectKey));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get artifact metadata without downloading
   */
  async getArtifactMetadata(bucket: string, objectKey: string): Promise<{ sizeBytes: number; contentHash: string }> {
    const destPath = this.getPath(objectKey);
    const stat = await fs.stat(destPath);
    
    const data = await fs.readFile(destPath);
    const hashSum = crypto.createHash('sha256');
    hashSum.update(data);
    const contentHash = hashSum.digest('hex');

    return {
      sizeBytes: stat.size,
      contentHash,
    };
  }

  /**
   * Download and verify integrity
   */
  async getArtifact(
    ref: S3ArtifactReference,
    destinationPath: string
  ): Promise<void> {
    const srcPath = this.getPath(ref.objectKey);
    
    try {
      await fs.access(srcPath);
    } catch {
      throw new Error(`Artifact not found on local disk: ${ref.objectKey}`);
    }

    await fs.mkdir(path.dirname(destinationPath), { recursive: true });

    // Stream download and verify hash
    const hashSum = crypto.createHash('sha256');
    const readStream = createReadStream(srcPath);
    const writeStream = createWriteStream(destinationPath);
    
    return new Promise((resolve, reject) => {
        readStream.on('data', (chunk) => hashSum.update(chunk));
        readStream.pipe(writeStream)
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

  /**
   * Get as stream (used by delivery)
   */
  async getArtifactStream(bucket: string, objectKey: string): Promise<Readable> {
    const srcPath = this.getPath(objectKey);
    return createReadStream(srcPath);
  }
}

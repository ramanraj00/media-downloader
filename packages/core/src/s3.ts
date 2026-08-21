import { S3ArtifactReference } from '@media-downloader/types';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
// import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';

export class S3Storage {
  private bucketPath: string;
  // private s3Client: S3Client;

  constructor(bucketPath: string = '/tmp/s3-mock-bucket') {
    this.bucketPath = bucketPath;
    
    // In production AWS, the S3Client will implicitly use the ECS Task Role
    // credentials without requiring AWS_ACCESS_KEY_ID in .env
    // this.s3Client = new S3Client({});
  }

  async init() {
    await fs.mkdir(this.bucketPath, { recursive: true });
  }

  /**
   * Idempotent upload with SHA-256 generation.
   */
  async putArtifact(
    bucket: string,
    objectKey: string,
    localFilePath: string,
    contentType: string = 'video/mp4'
  ): Promise<S3ArtifactReference> {
    const s3Path = path.join(this.bucketPath, bucket, objectKey);
    await fs.mkdir(path.dirname(s3Path), { recursive: true });

    // Read and calculate hash
    const data = await fs.readFile(localFilePath);
    const hashSum = crypto.createHash('sha256');
    hashSum.update(data);
    const contentHash = hashSum.digest('hex');

    // Simulate S3 PUT
    await fs.writeFile(s3Path, data);

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
    const s3Path = path.join(this.bucketPath, bucket, objectKey);
    try {
      await fs.stat(s3Path);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get artifact metadata without downloading
   */
  async getArtifactMetadata(bucket: string, objectKey: string): Promise<{ sizeBytes: number; contentHash: string }> {
    const s3Path = path.join(this.bucketPath, bucket, objectKey);
    const data = await fs.readFile(s3Path);
    const hashSum = crypto.createHash('sha256');
    hashSum.update(data);
    return {
      sizeBytes: data.length,
      contentHash: hashSum.digest('hex'),
    };
  }

  /**
   * Download and verify integrity
   */
  async getArtifact(
    ref: S3ArtifactReference,
    destinationPath: string
  ): Promise<void> {
    const s3Path = path.join(this.bucketPath, ref.bucket, ref.objectKey);
    
    let data: Buffer;
    try {
      data = await fs.readFile(s3Path);
    } catch (e) {
      throw new Error(`S3 Object not found: ${ref.bucket}/${ref.objectKey}`);
    }

    // Verify Integrity
    const hashSum = crypto.createHash('sha256');
    hashSum.update(data);
    const actualHash = hashSum.digest('hex');

    if (actualHash !== ref.contentHash) {
      throw new Error(`Integrity Error: Expected hash ${ref.contentHash}, got ${actualHash} for ${ref.objectKey}`);
    }

    await fs.mkdir(path.dirname(destinationPath), { recursive: true });
    await fs.writeFile(destinationPath, data);
  }
}

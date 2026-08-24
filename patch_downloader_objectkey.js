const fs = require('fs');
let code = fs.readFileSync('services/downloader/src/engine.ts', 'utf-8');

const target = `  // CHECKPOINT RESILIENCE: Check if S3 artifact already exists
  const objectKey = \`jobs/\${job.jobId}/raw/video.mp4\`;
  const bucket = config.ARTIFACT_BUCKET;
  
  if (await s3.artifactExists(bucket, objectKey)) {
    logger.info('S3 checkpoint found, skipping download and reusing artifact');
    const metadata = await s3.getArtifactMetadata(bucket, objectKey);
    return {
      filePath: 'S3_CHECKPOINT',
      info: { url: job.url, platform, ext: 'mp4' },
      sourceLayer: 's3_checkpoint',
      downloadTimeMs: 0,
      s3Artifact: {
        bucket,
        objectKey,
        sizeBytes: metadata.sizeBytes,
        contentType: 'video/mp4',
        contentHash: metadata.contentHash,
      }
    };
  }`;

const replacement = `  const bucket = config.ARTIFACT_BUCKET;
  
  // NOTE: We cannot easily do checkpoint resilience here because we don't know the exact file extension yet (.mp4, .jpg, .webp).
  // Ideally, we'd check a metadata DB record, not S3 directly. For now, we rely on BullMQ idempotency.
`;

code = code.replace(target, replacement);

const target2 = `      // SUCCESS — upload to S3 and return
      return await uploadAndCleanup(result, bucket, objectKey, logger);`;

const replacement2 = `      // SUCCESS — upload to S3 and return
      const path = require('path');
      const actualExt = path.extname(result.filePath) || '.mp4';
      const actualObjectKey = \`jobs/\${job.jobId}/raw/media\${actualExt}\`;
      return await uploadAndCleanup(result, bucket, actualObjectKey, logger);`;

code = code.replace(target2, replacement2);

fs.writeFileSync('services/downloader/src/engine.ts', code);
console.log('Patched downloader objectKey');

const fs = require('fs');
const file = 'packages/types/src/queue.ts';
let code = fs.readFileSync(file, 'utf-8');

const target = `export interface UploadJobData {
  jobId: string;
  processedArtifact: S3ArtifactReference;
}`;

const replacement = `export interface UploadJobData {
  jobId: string;
  processedArtifact: S3ArtifactReference;
  thumbArtifact?: S3ArtifactReference;
  width?: number;
  height?: number;
  duration?: number;
}`;

code = code.replace(target, replacement);
fs.writeFileSync(file, code);
console.log('Patched types');

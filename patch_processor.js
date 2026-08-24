const fs = require('fs');
const file = 'services/media-processor/src/worker.ts';
let code = fs.readFileSync(file, 'utf-8');

const target1 = `const contentHash = await calculateFileHash(result.filePath);`;
const replacement1 = `const contentHash = await calculateFileHash(result.filePath);
        
        // Extract thumbnail
        let thumbArtifactRef;
        if (mediaType === 'video') {
          jobLogger.info('Extracting thumbnail');
          const thumbPath = \`/tmp/\${bullJob.data.jobId}_thumb.jpg\`;
          try {
            // try to extract at 1s, fallback to 0s
            const execAsync = require('util').promisify(require('child_process').exec);
            try {
              await execAsync(\`ffmpeg -y -ss 00:00:01 -i "\${result.filePath}" -vframes 1 -q:v 2 "\${thumbPath}"\`);
            } catch(e) {
              await execAsync(\`ffmpeg -y -i "\${result.filePath}" -vframes 1 -q:v 2 "\${thumbPath}"\`);
            }
            if (require('fs').existsSync(thumbPath)) {
               const thumbKey = \`jobs/\${bullJob.data.jobId}/processed/thumb.jpg\`;
               thumbArtifactRef = await s3.putArtifact(config.ARTIFACT_BUCKET, thumbKey, thumbPath);
               require('fs').unlinkSync(thumbPath);
            }
          } catch(e) {
            jobLogger.warn('Failed to extract thumbnail', e);
          }
        }`;

const target2 = `const uploadData: UploadJobData = {
          jobId: bullJob.data.jobId,
          processedArtifact: processedArtifactRef,
        };`;
const replacement2 = `const uploadData = {
          jobId: bullJob.data.jobId,
          processedArtifact: processedArtifactRef,
          thumbArtifact: thumbArtifactRef,
          width: postFlightProbe.width,
          height: postFlightProbe.height,
          duration: postFlightProbe.duration,
        };`;

code = code.replace(target1, replacement1);
code = code.replace(target2, replacement2);
fs.writeFileSync(file, code);
console.log('Patched media-processor');

const fs = require('fs');
const file = 'services/delivery/src/worker.ts';
let code = fs.readFileSync(file, 'utf-8');

const target = `await s3.getArtifact(bullJob.data.processedArtifact, localPath);`;
const replacement = `await s3.getArtifact(bullJob.data.processedArtifact, localPath);
          let thumbLocalPath = undefined;
          if (bullJob.data.thumbArtifact) {
             thumbLocalPath = \`/tmp/\${bullJob.data.jobId}_thumb.jpg\`;
             try {
                await s3.getArtifact(bullJob.data.thumbArtifact, thumbLocalPath);
             } catch(e) {
                jobLogger.warn('Failed to download thumb artifact');
                thumbLocalPath = undefined;
             }
          }`;

const target2 = `const { fileId, messageId } = await uploadToTelegram(bullJob.data, localPath, jobRecord, jobLogger);`;
const replacement2 = `const { fileId, messageId } = await uploadToTelegram(bullJob.data, localPath, thumbLocalPath, jobRecord, jobLogger);
          if (thumbLocalPath) require('fs').unlinkSync(thumbLocalPath).catch(()=>{});`;

code = code.replace(target, replacement);
code = code.replace(target2, replacement2);
fs.writeFileSync(file, code);
console.log('Patched delivery worker');

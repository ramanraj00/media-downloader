const fs = require('fs');
const file = 'services/delivery/src/uploader.ts';
let code = fs.readFileSync(file, 'utf-8');

const target1 = `export async function uploadToTelegram(
  data: UploadJobData, 
  localPath: string,
  jobRecord: any, 
  logger: Logger
): Promise<{ fileId: string; messageId: number }> {`;

const replacement1 = `export async function uploadToTelegram(
  data: UploadJobData, 
  localPath: string,
  thumbLocalPath: string | undefined,
  jobRecord: any, 
  logger: Logger
): Promise<{ fileId: string; messageId: number }> {`;

const target2 = `      let thumbInput = undefined;
      if (data.thumbArtifact) {
         try {
           const thumbStream = await s3.getArtifactStream(data.thumbArtifact.bucket, data.thumbArtifact.key);
           thumbInput = new InputFile(thumbStream);
         } catch(e) {
           logger.warn('Failed to stream thumb artifact');
         }
      }`;

const replacement2 = `      let thumbInput = undefined;
      if (thumbLocalPath && fs.existsSync(thumbLocalPath)) {
         thumbInput = new InputFile(thumbLocalPath);
      }`;

code = code.replace(target1, replacement1);
code = code.replace(target2, replacement2);
fs.writeFileSync(file, code);
console.log('Patched delivery uploader');

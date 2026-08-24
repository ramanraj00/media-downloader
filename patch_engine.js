const fs = require('fs');
let code = fs.readFileSync('services/downloader/src/engine.ts', 'utf-8');

const target = `      const s3Artifact = await s3.putArtifact(
        config.S3_BUCKET_NAME,
        objectKey,
        result.filePath
      );`;

const replacement = `      const stat = require('fs').statSync(result.filePath);
      if (stat.size > 50 * 1024 * 1024) {
        throw new PermanentError('File exceeds Telegram 50MB bot upload limit');
      }
      
      const s3Artifact = await s3.putArtifact(
        config.S3_BUCKET_NAME,
        objectKey,
        result.filePath
      );`;

code = code.replace(target, replacement);
fs.writeFileSync('services/downloader/src/engine.ts', code);
console.log("Patched engine.ts");

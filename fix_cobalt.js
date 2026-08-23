const fs = require('fs');
let code = fs.readFileSync('services/downloader/src/platforms/cobalt.ts', 'utf-8');

// 1. Import AuthRequiredError
code = code.replace(
  "  DatacenterBlockedError,\n  AdmissionController",
  "  DatacenterBlockedError,\n  AuthRequiredError,\n  AdmissionController"
);

// 2. Add the check and ext extraction
const target = `      const streamUrl = data?.url;
      if (!streamUrl) {
        throw new PermanentError('Cobalt returned success but no URL');
      }`;

const replacement = `      const streamUrl = data?.url;
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
      }`;

code = code.replace(target, replacement);

// 3. Fix the path.join line
code = code.replace(
  "const filePath = path.join(outputDir, `cobalt_${crypto.randomUUID()}.mp4`);",
  "const filePath = path.join(outputDir, `cobalt_${crypto.randomUUID()}.${ext}`);"
);

// 4. Fix metadata ext
code = code.replace(
  "metadata: { url: urlStr, platform: this.platform, ext: 'mp4', downloadTimeMs: Date.now() - startTime }",
  "metadata: { url: urlStr, platform: this.platform, ext, downloadTimeMs: Date.now() - startTime }"
);

fs.writeFileSync('services/downloader/src/platforms/cobalt.ts', code);

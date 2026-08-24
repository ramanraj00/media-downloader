const fs = require('fs');
let code = fs.readFileSync('packages/core/src/s3.ts', 'utf-8');

code = code.replace(
`    contentType: string = 'video/mp4'`,
`    contentType?: string`
);

const target = `    // Read and calculate hash`;
const replacement = `    if (!contentType) {
      const ext = require('path').extname(objectKey).toLowerCase();
      if (['.jpg', '.jpeg'].includes(ext)) contentType = 'image/jpeg';
      else if (ext === '.png') contentType = 'image/png';
      else if (ext === '.webp') contentType = 'image/webp';
      else contentType = 'video/mp4';
    }

    // Read and calculate hash`;

code = code.replace(target, replacement);
fs.writeFileSync('packages/core/src/s3.ts', code);
console.log("Patched s3.ts");

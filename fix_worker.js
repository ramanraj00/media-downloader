const fs = require('fs');
let code = fs.readFileSync('services/media-processor/src/worker.ts', 'utf-8');

const target = 'const objectKey = `jobs/${bullJob.data.jobId}/processed/video.mp4`;';
const replacement = 'const ext = require("path").extname(result.filePath) || ".mp4";\n        const objectKey = `jobs/${bullJob.data.jobId}/processed/media${ext}`;';

code = code.replace(target, replacement);
fs.writeFileSync('services/media-processor/src/worker.ts', code);

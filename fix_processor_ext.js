const fs = require('fs');
let code = fs.readFileSync('services/media-processor/src/worker.ts', 'utf-8');

const target = "const inputPath = path.join(config.TEMP_DIR, \`job_\${bullJob.data.jobId}_raw.mp4\`);";
const replacement = `const originalExt = require('path').extname(bullJob.data.rawArtifact.key) || '.mp4';
      const inputPath = path.join(config.TEMP_DIR, \`job_\${bullJob.data.jobId}_raw\${originalExt}\`);`;

code = code.replace(target, replacement);
fs.writeFileSync('services/media-processor/src/worker.ts', code);
console.log("Patched worker.ts again");

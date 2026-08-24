const fs = require('fs');
const file = 'services/media-processor/src/worker.ts';
let code = fs.readFileSync(file, 'utf-8');

const target1 = `await execAsync(\`ffmpeg -y -ss 00:00:01 -i "\${result.filePath}" -vframes 1 -q:v 2 "\${thumbPath}"\`);`;
const replacement1 = `await execAsync(\`ffmpeg -y -ss 00:00:01 -i "\${result.filePath}" -vframes 1 -vf "scale='min(320,iw)':min'(320,ih)':force_original_aspect_ratio=decrease" -q:v 2 "\${thumbPath}"\`);`;

const target2 = `await execAsync(\`ffmpeg -y -i "\${result.filePath}" -vframes 1 -q:v 2 "\${thumbPath}"\`);`;
const replacement2 = `await execAsync(\`ffmpeg -y -i "\${result.filePath}" -vframes 1 -vf "scale='min(320,iw)':min'(320,ih)':force_original_aspect_ratio=decrease" -q:v 2 "\${thumbPath}"\`);`;

code = code.replace(target1, replacement1);
code = code.replace(target2, replacement2);
fs.writeFileSync(file, code);
console.log('Patched media-processor scale');

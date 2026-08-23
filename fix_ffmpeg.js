const fs = require('fs');
let code = fs.readFileSync('services/media-processor/src/ffmpeg.ts', 'utf-8');

const target = "-preset ultrafast -crf 28";
const replacement = "-threads 1 -preset ultrafast -crf 28";

code = code.replace(target, replacement);
fs.writeFileSync('services/media-processor/src/ffmpeg.ts', code);

const fs = require('fs');
let code = fs.readFileSync('services/media-processor/src/ffmpeg.ts', 'utf-8');

const targetCmd = 'const cmd = `ffmpeg -y -i "${inputPath}" ${mapArgs} -c:v libx264 -preset medium -b:v ${videoBitrate} -pass 1 -an -f mp4 /dev/null && ffmpeg -y -i "${inputPath}" ${mapArgs} -c:v libx264 -preset medium -b:v ${videoBitrate} -pass 2 ${audioCodecStr} -movflags +faststart "${outputPath}"`;';
const newCmd = 'const cmd = `ffmpeg -y -i "${inputPath}" ${mapArgs} -c:v libx264 -preset ultrafast -crf 28 ${audioCodecStr} -movflags +faststart "${outputPath}"`;';

code = code.replace(targetCmd, newCmd);
fs.writeFileSync('services/media-processor/src/ffmpeg.ts', code);

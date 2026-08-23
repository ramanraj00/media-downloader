const fs = require('fs');
let code = fs.readFileSync('services/media-processor/src/ffmpeg.ts', 'utf-8');

const target = `  if (mediaType === 'audio') {`;
const replacement = `  if (mediaType === 'photo') {
    logger.info('File is photo, skipping transcode');
    return {
      filePath: inputPath,
      mediaType: 'photo',
      fileSize: probe.fileSize,
      hasAudio: false,
      wasConverted: false,
    };
  }

  if (mediaType === 'audio') {`;

code = code.replace(target, replacement);
fs.writeFileSync('services/media-processor/src/ffmpeg.ts', code);

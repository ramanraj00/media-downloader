const fs = require('fs');
let code = fs.readFileSync('services/media-processor/src/ffmpeg.ts', 'utf-8');

const target = `  const isCompatible = isMp4 && isH264 && isAac && isUnderSize && !probe.durationMismatch;

  if (isCompatible) {`;

const replacement = `  const isCompatible = isMp4 && isH264 && isAac && isUnderSize && !probe.durationMismatch;
  logger.info({
    isMp4,
    isH264,
    isAac,
    isUnderSize,
    durationMismatch: probe.durationMismatch,
    videoCodec: probe.videoCodec,
    container: probe.container,
    audioCodec: selectedAudio?.codec_name
  }, 'Compatibility check results');

  if (isCompatible) {`;

code = code.replace(target, replacement);
fs.writeFileSync('services/media-processor/src/ffmpeg.ts', code);
console.log("Patched ffmpeg.ts");

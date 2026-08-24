const fs = require('fs');
let code = fs.readFileSync('services/media-processor/src/ffmpeg.ts', 'utf-8');

// The messed up line:
// const isCompatible = isMp4 const isCompatible = isMp4 && isH264 && isAac && isUnderSize && !probe.durationMismatch;const isCompatible = isMp4 && isH264 && isAac && isUnderSize && !probe.durationMismatch; isH264 const isCompatible = isMp4 && isH264 && isAac && isUnderSize && !probe.durationMismatch;const isCompatible = isMp4 && isH264 && isAac && isUnderSize && !probe.durationMismatch; isAac const isCompatible = isMp4 && isH264 && isAac && isUnderSize && !probe.durationMismatch;const isCompatible = isMp4 && isH264 && isAac && isUnderSize && !probe.durationMismatch; isUnderSize;

code = code.replace(/const isCompatible = .*/, 'const isCompatible = isMp4 && isH264 && isAac && isUnderSize;');

fs.writeFileSync('services/media-processor/src/ffmpeg.ts', code);
console.log('Fixed');

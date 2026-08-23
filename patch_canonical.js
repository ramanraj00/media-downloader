const fs = require('fs');

// Patch ffmpeg.ts
let ffmpegCode = fs.readFileSync('services/media-processor/src/ffmpeg.ts', 'utf-8');
ffmpegCode = ffmpegCode.replace(
  "probe.videoCodec === 'h264' &&",
  "(probe.videoCodec === 'h264' || probe.videoCodec === 'hevc' || probe.videoCodec === 'h265') &&"
);
ffmpegCode = ffmpegCode.replace(
  "Video is canonical (H264/AAC/MP4)",
  "Video is canonical (H264/HEVC/AAC/MP4)"
);
fs.writeFileSync('services/media-processor/src/ffmpeg.ts', ffmpegCode);

// Patch worker.ts validation
let workerCode = fs.readFileSync('services/media-processor/src/worker.ts', 'utf-8');
workerCode = workerCode.replace(
  "postFlightProbe.videoCodec !== 'h264'",
  "postFlightProbe.videoCodec !== 'h264' && postFlightProbe.videoCodec !== 'hevc' && postFlightProbe.videoCodec !== 'h265'"
);
workerCode = workerCode.replace(
  "Expected canonical H.264 video",
  "Expected canonical H.264/HEVC video"
);
fs.writeFileSync('services/media-processor/src/worker.ts', workerCode);

console.log("Patched HEVC as canonical");

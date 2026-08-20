import { runProbe, determineMediaType } from './probe';
import { normalizeVideo } from './ffmpeg';
import { exec } from 'child_process';
import util from 'util';
import fs from 'fs';

const execAsync = util.promisify(exec);
const TEST_DIR = '/tmp/9d_prod_tests';

// Custom logger to capture decisions
class CaptureLogger {
  public lastCmd: string = '';
  public lastSelectedAudio: any = null;
  public copyTranscodeDecision: string = '';

  info(obj: any, msg?: string) {
    if (typeof obj === 'string') {
      if (obj.includes('Applying copy')) this.copyTranscodeDecision = 'COPY';
      if (obj.includes('Transcoding video')) this.copyTranscodeDecision = 'TRANSCODE';
      if (obj.includes('File is photo')) this.copyTranscodeDecision = 'PHOTO_KEEP';
      if (obj.includes('stripping video')) this.copyTranscodeDecision = 'AUDIO_TRANSCODE';
      return;
    }
    if (obj.cmd) this.lastCmd = obj.cmd;
    if (msg === 'Selected audio stream') this.lastSelectedAudio = obj;
    if (msg?.includes('Applying copy')) this.copyTranscodeDecision = 'COPY';
    if (msg?.includes('Transcoding video')) this.copyTranscodeDecision = 'TRANSCODE';
  }
  warn(obj: any, msg?: string) {}
  error(obj: any, msg?: string) {}
  fatal(obj: any, msg?: string) {}
  debug(obj: any, msg?: string) {}
  trace(obj: any, msg?: string) {}
  child() { return this; }
}

async function runCmd(cmd: string) {
  await execAsync(cmd);
}

async function setupTestFiles() {
  console.log('Generating test files...');
  if (!fs.existsSync(TEST_DIR)) fs.mkdirSync(TEST_DIR, { recursive: true });
  
  // Base assets
  await runCmd(`ffmpeg -y -f lavfi -i testsrc=duration=10:size=320x240:rate=30 -c:v libx264 ${TEST_DIR}/v10.mp4`);
  await runCmd(`ffmpeg -y -f lavfi -i testsrc=duration=30:size=320x240:rate=30 -c:v libx264 ${TEST_DIR}/v30.mp4`);
  await runCmd(`ffmpeg -y -f lavfi -i sine=frequency=1000:duration=10 -c:a aac ${TEST_DIR}/a10.m4a`);
  await runCmd(`ffmpeg -y -f lavfi -i sine=frequency=1000:duration=30 -c:a aac ${TEST_DIR}/a30.m4a`);

  // 1. H264 + AAC
  await runCmd(`ffmpeg -y -i ${TEST_DIR}/v10.mp4 -i ${TEST_DIR}/a10.m4a -c copy -map 0:v -map 1:a ${TEST_DIR}/1_h264_aac.mp4`);
  // 2. H264 video-only
  await runCmd(`cp ${TEST_DIR}/v10.mp4 ${TEST_DIR}/2_h264_only.mp4`);
  // 3. HEVC + AAC
  await runCmd(`ffmpeg -y -i ${TEST_DIR}/v10.mp4 -i ${TEST_DIR}/a10.m4a -c:v libx265 -c:a aac -map 0:v -map 1:a ${TEST_DIR}/3_hevc_aac.mp4`);
  // 4. VP9 + AAC
  await runCmd(`ffmpeg -y -i ${TEST_DIR}/v10.mp4 -i ${TEST_DIR}/a10.m4a -c:v libvpx-vp9 -c:a aac -map 0:v -map 1:a ${TEST_DIR}/4_vp9_aac.mkv`);
  // 5. 10s V + 30s A
  await runCmd(`ffmpeg -y -i ${TEST_DIR}/v10.mp4 -i ${TEST_DIR}/a30.m4a -c copy -map 0:v -map 1:a ${TEST_DIR}/5_v10_a30.mp4`);
  // 6. 30s V + 10s A
  await runCmd(`ffmpeg -y -i ${TEST_DIR}/v30.mp4 -i ${TEST_DIR}/a10.m4a -c copy -map 0:v -map 1:a ${TEST_DIR}/6_v30_a10.mp4`);
  // 7. multiple audio (default on #0) -> Wait, audio stream 0 is global 1.
  await runCmd(`ffmpeg -y -i ${TEST_DIR}/v10.mp4 -i ${TEST_DIR}/a10.m4a -f lavfi -i sine=frequency=440:duration=10 -c copy -map 0:v -map 1:a -map 2:a -c:a:1 aac -disposition:a:0 default -disposition:a:1 0 ${TEST_DIR}/7_multi_def0.mp4`);
  // 8. .ogg audio-only
  await runCmd(`ffmpeg -y -i ${TEST_DIR}/a10.m4a -c:a flac ${TEST_DIR}/8_audio_only.ogg`);
  // 9. JPEG/image
  await runCmd(`ffmpeg -y -f lavfi -i color=c=red:s=320x240 -frames:v 1 ${TEST_DIR}/9_image.jpg`);
  // 10. corrupted input
  fs.writeFileSync(`${TEST_DIR}/10_corrupt.mp4`, 'corrupt data here');
  // 11. multiple audio where default is NOT stream #0 (global #2 is default)
  await runCmd(`ffmpeg -y -i ${TEST_DIR}/v10.mp4 -i ${TEST_DIR}/a10.m4a -f lavfi -i sine=frequency=440:duration=10 -c copy -map 0:v -map 1:a -map 2:a -c:a:1 aac -disposition:a:0 0 -disposition:a:1 default ${TEST_DIR}/11_multi_def1.mp4`);
}

function printStreams(streams: any[]) {
  streams.forEach(s => {
    console.log(`  ├── stream #${s.index} (${s.codec_type}): ${s.codec_name} | dur: ${s.duration} | default: ${s.isDefault}`);
  });
}

async function runScenario(id: number, filePath: string, desc: string) {
  console.log(`\n==================================================`);
  console.log(`SCENARIO ${id}: ${desc}`);
  console.log(`File: ${filePath}`);
  
  let preFlightProbe: any;
  let mediaType: any;
  const logger = new CaptureLogger();

  try {
    preFlightProbe = await runProbe(filePath);
    mediaType = determineMediaType(preFlightProbe);
    
    console.log(`\n[INPUT]`);
    console.log(`├── container: ${preFlightProbe.container}`);
    console.log(`├── video codec: ${preFlightProbe.videoCodec || 'none'}`);
    console.log(`├── audio codec: ${preFlightProbe.audioCodec || 'none'}`);
    console.log(`├── durations (V: ${preFlightProbe.videoDuration}, A: ${preFlightProbe.audioDuration})`);
    console.log(`└── streams:`);
    printStreams(preFlightProbe.streams);

    if (mediaType === 'document') {
      throw new Error('Unsupported media format or corrupted file');
    }

    const result = await normalizeVideo(filePath, preFlightProbe, mediaType, logger as any);
    
    console.log(`\n[DECISION]`);
    console.log(`├── mediaType: ${mediaType}`);
    console.log(`├── selected audio: ${JSON.stringify(logger.lastSelectedAudio || 'none')}`);
    console.log(`├── copy/transcode: ${logger.copyTranscodeDecision}`);
    console.log(`├── duration mismatch padded/trimmed: ${preFlightProbe.durationMismatch ? 'YES' : 'NO'}`);
    console.log(`└── FFmpeg Command: ${logger.lastCmd || 'none'}`);

    const postFlightProbe = await runProbe(result.filePath);
    
    console.log(`\n[OUTPUT]`);
    console.log(`├── container: ${postFlightProbe.container}`);
    console.log(`├── video codec: ${postFlightProbe.videoCodec || 'none'}`);
    console.log(`├── audio codec: ${postFlightProbe.audioCodec || 'none'}`);
    console.log(`├── stream count: ${postFlightProbe.streams.length}`);
    console.log(`├── durations (V: ${postFlightProbe.videoDuration}, A: ${postFlightProbe.audioDuration})`);
    
    // Worker Validation
    if (postFlightProbe.fileSize === 0) throw new Error('Output is 0 bytes');
    if (mediaType === 'video') {
      if (!postFlightProbe.hasVideo) throw new Error('Expected video stream but none found');
      if (postFlightProbe.videoCodec !== 'h264') throw new Error(`Expected H.264 video, got ${postFlightProbe.videoCodec}`);
    }
    if (result.hasAudio) {
      if (!postFlightProbe.hasAudio) throw new Error('Expected audio stream but none found');
      if (postFlightProbe.audioCodec !== 'aac') throw new Error(`Expected AAC audio, got ${postFlightProbe.audioCodec}`);
    }
    if (postFlightProbe.durationMismatch) {
      throw new Error(`Duration mismatch is still present (Video: ${postFlightProbe.videoDuration}s, Audio: ${postFlightProbe.audioDuration}s)`);
    }
    const postAudioCount = postFlightProbe.streams.filter((s: any) => s.codec_type === 'audio').length;
    if (result.hasAudio && postAudioCount > 1) {
      throw new Error(`Multiple audio tracks are still present (${postAudioCount}). Expected exactly 1.`);
    }

    console.log(`└── validation result: ✅ SUCCESS`);
  } catch (err: any) {
    if (!preFlightProbe) {
      console.log(`\n[INPUT] FAILED TO PROBE`);
    }
    console.log(`\n[DECISION] FAILED or REJECTED`);
    console.log(`└── validation result: ❌ FAILED - ${err.message}`);
  }
}

async function runAll() {
  await setupTestFiles();
  
  await runScenario(1, `${TEST_DIR}/1_h264_aac.mp4`, 'H264 + AAC (compatible copy)');
  await runScenario(2, `${TEST_DIR}/2_h264_only.mp4`, 'H264 video-only (compatible copy)');
  await runScenario(3, `${TEST_DIR}/3_hevc_aac.mp4`, 'HEVC + AAC (transcode)');
  await runScenario(4, `${TEST_DIR}/4_vp9_aac.mkv`, 'VP9 + AAC (transcode)');
  await runScenario(5, `${TEST_DIR}/5_v10_a30.mp4`, '10s V + 30s A (mismatch padding/trimming)');
  await runScenario(6, `${TEST_DIR}/6_v30_a10.mp4`, '30s V + 10s A (mismatch padding/trimming)');
  await runScenario(7, `${TEST_DIR}/7_multi_def0.mp4`, 'multiple audio (default on #0)');
  await runScenario(8, `${TEST_DIR}/8_audio_only.ogg`, '.ogg audio-only');
  await runScenario(9, `${TEST_DIR}/9_image.jpg`, 'JPEG/image');
  await runScenario(10, `${TEST_DIR}/10_corrupt.mp4`, 'corrupted input');
  await runScenario(11, `${TEST_DIR}/11_multi_def1.mp4`, 'multiple audio where default is NOT stream #0 (Test 11)');

  process.exit(0);
}

runAll().catch(console.error);

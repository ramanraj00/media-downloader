import { runProbe, determineMediaType } from './probe';
import { normalizeVideo } from './ffmpeg';
import pino from 'pino';
import { exec } from 'child_process';
import util from 'util';
import fs from 'fs';

const execAsync = util.promisify(exec);
const logger = pino({ level: 'silent' });

async function setupTestFiles() {
  console.log('Generating test files...');
  if (!fs.existsSync('/tmp/9c_tests')) {
    fs.mkdirSync('/tmp/9c_tests', { recursive: true });
  }

  // 1. video + audio
  await execAsync(`ffmpeg -y -f lavfi -i testsrc=duration=5:size=320x240:rate=30 -f lavfi -i sine=frequency=1000:duration=5 -c:v libx264 -c:a aac /tmp/9c_tests/1_vid_aud.mp4`);
  
  // 2. video only
  await execAsync(`ffmpeg -y -f lavfi -i testsrc=duration=5:size=320x240:rate=30 -c:v libx264 /tmp/9c_tests/2_vid_only.mp4`);
  
  // 3. audio only
  await execAsync(`ffmpeg -y -f lavfi -i sine=frequency=1000:duration=5 -c:a aac /tmp/9c_tests/3_aud_only.m4a`);
  
  // 4. image
  await execAsync(`ffmpeg -y -f lavfi -i color=c=red:s=320x240 -frames:v 1 /tmp/9c_tests/4_image.jpg`);
  
  // 5. unsupported extension but valid audio (e.g. .ogg extension)
  await execAsync(`ffmpeg -y -f lavfi -i sine=frequency=1000:duration=5 -c:a flac /tmp/9c_tests/5_valid_aud.ogg`);
  
  // 6. unsupported extension but valid video
  await execAsync(`ffmpeg -y -f lavfi -i testsrc=duration=5:size=320x240:rate=30 -c:v libx264 /tmp/9c_tests/6_valid_vid.mkv`);
  
  // 7. zero-byte file
  fs.writeFileSync('/tmp/9c_tests/7_zero_byte.mp4', '');
  
  // 8. corrupted media
  fs.writeFileSync('/tmp/9c_tests/8_corrupt.mp4', 'this is not a valid video file content at all');
  
  // 9. multiple audio streams
  await execAsync(`ffmpeg -y -f lavfi -i testsrc=duration=5:size=320x240:rate=30 -f lavfi -i sine=frequency=1000:duration=5 -f lavfi -i sine=frequency=440:duration=5 -map 0:v -map 1:a -map 2:a -c:v libx264 -c:a aac /tmp/9c_tests/9_multi_aud.mp4`);
  
  // 10. mismatched audio/video duration
  await execAsync(`ffmpeg -y -f lavfi -i testsrc=duration=10:size=320x240:rate=30 -f lavfi -i sine=frequency=1000:duration=30 -map 0:v -map 1:a -c:v libx264 -c:a aac /tmp/9c_tests/10_mismatch.mp4`);
}

async function runScenario(scenarioId: number, filePath: string, desc: string) {
  console.log(`\n==================================================`);
  console.log(`SCENARIO ${scenarioId}: ${desc}`);
  console.log(`File: ${filePath}`);
  
  try {
    // PRE-FLIGHT
    const preFlightProbe = await runProbe(filePath);
    const mediaType = determineMediaType(preFlightProbe);
    
    console.log(`[PRE-FLIGHT] mediaType Decided: ${mediaType}`);
    console.log(`[PRE-FLIGHT] hasVideo: ${preFlightProbe.hasVideo}, hasAudio: ${preFlightProbe.hasAudio}`);
    console.log(`[PRE-FLIGHT] Streams: ${JSON.stringify(preFlightProbe.streams.map((s: any) => ({ type: s.codec_type, codec: s.codec_name, duration: s.duration })))}`);
    
    if (mediaType === 'document') {
      throw new Error('Pre-flight validation failed: Unsupported media format or corrupted file');
    }

    // NORMALIZATION
    console.log(`[NORMALIZATION] Processing as ${mediaType}...`);
    const result = await normalizeVideo(filePath, preFlightProbe, mediaType, logger);
    
    // POST-FLIGHT
    const postFlightProbe = await runProbe(result.filePath);
    
    console.log(`[POST-FLIGHT] hasVideo: ${postFlightProbe.hasVideo}, hasAudio: ${postFlightProbe.hasAudio}`);
    console.log(`[POST-FLIGHT] Streams: ${JSON.stringify(postFlightProbe.streams.map((s: any) => ({ type: s.codec_type, codec: s.codec_name, duration: s.duration })))}`);
    
    // VALIDATION LOGIC (Copy from worker.ts)
    if (postFlightProbe.fileSize === 0) {
      throw new Error('Output validation failed: File is 0 bytes');
    }
    if (mediaType === 'video' && !postFlightProbe.hasVideo) {
      throw new Error('Output validation failed: Expected video stream but none found');
    }
    if (preFlightProbe.hasAudio && !postFlightProbe.hasAudio) {
      throw new Error('Output validation failed: Expected audio stream but none found');
    }
    if (postFlightProbe.durationMismatch) {
      throw new Error(`Output validation failed: Duration mismatch (Video: ${postFlightProbe.videoDuration}s, Audio: ${postFlightProbe.audioDuration}s). Flagging for Phase 9D.`);
    }
    
    const preAudioCount = preFlightProbe.streams.filter((s: any) => s.codec_type === 'audio').length;
    const postAudioCount = postFlightProbe.streams.filter((s: any) => s.codec_type === 'audio').length;
    if (preAudioCount > 1 && postAudioCount < preAudioCount) {
      throw new Error(`Output validation failed: Multiple audio tracks were silently dropped (Pre: ${preAudioCount}, Post: ${postAudioCount}). Flagging for Phase 9D.`);
    }

    console.log(`✅ RESULT: SUCCESS! File ready for delivery.`);

  } catch (error: any) {
    console.log(`❌ RESULT: VALIDATION FAILED / REJECTED`);
    console.log(`   Reason: ${error.message}`);
  }
}

async function runAll() {
  await setupTestFiles();
  
  await runScenario(1, '/tmp/9c_tests/1_vid_aud.mp4', 'video + audio');
  await runScenario(2, '/tmp/9c_tests/2_vid_only.mp4', 'video only');
  await runScenario(3, '/tmp/9c_tests/3_aud_only.m4a', 'audio only');
  await runScenario(4, '/tmp/9c_tests/4_image.jpg', 'image');
  await runScenario(5, '/tmp/9c_tests/5_valid_aud.ogg', 'unsupported extension but valid audio');
  await runScenario(6, '/tmp/9c_tests/6_valid_vid.mkv', 'unsupported extension but valid video');
  await runScenario(7, '/tmp/9c_tests/7_zero_byte.mp4', 'zero-byte file');
  await runScenario(8, '/tmp/9c_tests/8_corrupt.mp4', 'corrupted media');
  await runScenario(9, '/tmp/9c_tests/9_multi_aud.mp4', 'multiple audio streams');
  await runScenario(10, '/tmp/9c_tests/10_mismatch.mp4', 'mismatched audio/video duration');
  
  process.exit(0);
}

runAll().catch(console.error);

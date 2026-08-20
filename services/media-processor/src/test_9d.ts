import { exec } from 'child_process';
import util from 'util';
import fs from 'fs';
import path from 'path';

const execAsync = util.promisify(exec);
const TEST_DIR = '/tmp/9d_tests';

async function runCmd(cmd: string) {
  try {
    await execAsync(cmd);
  } catch (e: any) {
    console.error(`Command failed: ${cmd}\n${e.message}`);
    throw e;
  }
}

async function probe(file: string) {
  const { stdout } = await execAsync(`ffprobe -v quiet -print_format json -show_format -show_streams "${file}"`);
  const data = JSON.parse(stdout);
  return {
    format: data.format.format_name,
    duration: data.format.duration,
    streams: data.streams.map((s: any) => ({
      index: s.index,
      type: s.codec_type,
      codec: s.codec_name,
      duration: s.duration,
      default: s.disposition?.default
    }))
  };
}

async function setup() {
  if (!fs.existsSync(TEST_DIR)) fs.mkdirSync(TEST_DIR, { recursive: true });
  
  // Base assets
  await runCmd(`ffmpeg -y -f lavfi -i testsrc=duration=10:size=320x240:rate=30 -c:v libx264 ${TEST_DIR}/v10.mp4`);
  await runCmd(`ffmpeg -y -f lavfi -i testsrc=duration=30:size=320x240:rate=30 -c:v libx264 ${TEST_DIR}/v30.mp4`);
  await runCmd(`ffmpeg -y -f lavfi -i sine=frequency=1000:duration=10 -c:a aac ${TEST_DIR}/a10.m4a`);
  await runCmd(`ffmpeg -y -f lavfi -i sine=frequency=1000:duration=30 -c:a aac ${TEST_DIR}/a30.m4a`);
  
  // Test A: 10s video + 30s audio
  await runCmd(`ffmpeg -y -i ${TEST_DIR}/v10.mp4 -i ${TEST_DIR}/a30.m4a -c copy -map 0:v -map 1:a ${TEST_DIR}/testA_in.mp4`);
  
  // Test B: 30s video + 10s audio
  await runCmd(`ffmpeg -y -i ${TEST_DIR}/v30.mp4 -i ${TEST_DIR}/a10.m4a -c copy -map 0:v -map 1:a ${TEST_DIR}/testB_in.mp4`);
  
  // Test C: Video + Eng (no def) + Hin (def)
  await runCmd(`ffmpeg -y -f lavfi -i sine=frequency=440:duration=10 -c:a aac ${TEST_DIR}/a10_hin.m4a`);
  await runCmd(`ffmpeg -y -i ${TEST_DIR}/v10.mp4 -i ${TEST_DIR}/a10.m4a -i ${TEST_DIR}/a10_hin.m4a -map 0:v -map 1:a -map 2:a -c copy -metadata:s:a:0 language=eng -disposition:a:0 0 -metadata:s:a:1 language=hin -disposition:a:1 default ${TEST_DIR}/testC_in.mp4`);
  
  // Test D: H264 + AAC
  await runCmd(`ffmpeg -y -i ${TEST_DIR}/v10.mp4 -i ${TEST_DIR}/a10.m4a -c:v libx264 -c:a aac -map 0:v -map 1:a ${TEST_DIR}/testD_in.mp4`);
  
  // Test E: HEVC + AAC
  await runCmd(`ffmpeg -y -i ${TEST_DIR}/v10.mp4 -i ${TEST_DIR}/a10.m4a -c:v libx265 -c:a aac -map 0:v -map 1:a ${TEST_DIR}/testE_in.mp4`);
  
  // Test F: VP9 + AAC (in webm usually, but testing codec)
  await runCmd(`ffmpeg -y -i ${TEST_DIR}/v10.mp4 -i ${TEST_DIR}/a10.m4a -c:v libvpx-vp9 -c:a aac -map 0:v -map 1:a ${TEST_DIR}/testF_in.mkv`);
  
  // Test G: video only
  await runCmd(`cp ${TEST_DIR}/v10.mp4 ${TEST_DIR}/testG_in.mp4`);
  
  // Test H: audio only
  await runCmd(`cp ${TEST_DIR}/a10.m4a ${TEST_DIR}/testH_in.m4a`);
  
  // Test I: MJPEG photo
  await runCmd(`ffmpeg -y -f lavfi -i color=c=red:s=320x240 -frames:v 1 ${TEST_DIR}/testI_in.jpg`);
}

async function experiment(name: string, inFile: string, outFile: string, ffmpegArgs: string) {
  console.log(`\n==================================================`);
  console.log(`EXPERIMENT ${name}`);
  const before = await probe(inFile);
  console.log(`[BEFORE] ${path.basename(inFile)}`);
  console.log(`  Format: ${before.format}, Duration: ${before.duration}`);
  before.streams.forEach((s: any) => console.log(`  - Stream ${s.index}: ${s.type} (${s.codec}) [dur: ${s.duration}, def: ${s.default}]`));
  
  console.log(`[FFMPEG] ffmpeg -i input ${ffmpegArgs} output`);
  await runCmd(`ffmpeg -y -i ${inFile} ${ffmpegArgs} ${outFile}`);
  
  const after = await probe(outFile);
  console.log(`[AFTER] ${path.basename(outFile)}`);
  console.log(`  Format: ${after.format}, Duration: ${after.duration}`);
  after.streams.forEach((s: any) => console.log(`  - Stream ${s.index}: ${s.type} (${s.codec}) [dur: ${s.duration}, def: ${s.default}]`));
}

async function run() {
  await setup();
  
  // A & B: Duration mismatch - Use apad + shortest
  // Note: apad works on audio streams. If we just have -c:v copy -c:a aac -af apad -shortest it fixes both scenarios.
  await experiment('A (10s V + 30s A -> pad/shortest)', `${TEST_DIR}/testA_in.mp4`, `${TEST_DIR}/testA_out.mp4`, `-c:v copy -c:a aac -af apad -shortest`);
  await experiment('B (30s V + 10s A -> pad/shortest)', `${TEST_DIR}/testB_in.mp4`, `${TEST_DIR}/testB_out.mp4`, `-c:v copy -c:a aac -af apad -shortest`);
  
  // C: Multiple audio tracks. We simulate our code picking the default track (index 2).
  // In code, we'd find the default track index. Here we explicitly map 0:v:0 and 0:a:1 (which is stream 2).
  await experiment('C (Multiple Audio -> Select Default)', `${TEST_DIR}/testC_in.mp4`, `${TEST_DIR}/testC_out.mp4`, `-map 0:v:0 -map 0:a:1 -c copy`);
  
  // D: H264 + AAC -> copy path
  await experiment('D (H264/AAC -> copy)', `${TEST_DIR}/testD_in.mp4`, `${TEST_DIR}/testD_out.mp4`, `-c copy`);
  
  // E: HEVC -> H264 transcode
  await experiment('E (HEVC -> H264 transcode)', `${TEST_DIR}/testE_in.mp4`, `${TEST_DIR}/testE_out.mp4`, `-c:v libx264 -preset ultrafast -c:a copy`);
  
  // F: VP9 -> H264 transcode
  await experiment('F (VP9 -> H264 transcode)', `${TEST_DIR}/testF_in.mkv`, `${TEST_DIR}/testF_out.mp4`, `-c:v libx264 -preset ultrafast -c:a copy`);
  
  // G: Video only
  await experiment('G (Video Only -> keep video only)', `${TEST_DIR}/testG_in.mp4`, `${TEST_DIR}/testG_out.mp4`, `-c:v libx264 -preset ultrafast -an`);
  
  // H: Audio only
  await experiment('H (Audio Only -> keep audio only)', `${TEST_DIR}/testH_in.m4a`, `${TEST_DIR}/testH_out.m4a`, `-vn -c:a aac`);
  
  // I: MJPEG image
  await experiment('I (MJPEG Image -> photo processing)', `${TEST_DIR}/testI_in.jpg`, `${TEST_DIR}/testI_out.jpg`, `-c copy`);
}

run().catch(console.error);

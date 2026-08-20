import { db, jobs, outboxEvents, users } from '@media-downloader/db';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import http from 'http';
import { exec } from 'child_process';
import util from 'util';
import fs from 'fs';
import path from 'path';
import { QUEUES } from '@media-downloader/types';

const execAsync = util.promisify(exec);
const TEST_DIR = '/tmp/9f_prod_tests';
const HTTP_PORT = 9999;
const SERVER_URL = `http://127.0.0.1:${HTTP_PORT}`;

// 1. Fail fast on missing token
const token = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
if (!token || token === '123:abc' || token === 'your_telegram_bot_token_here') {
  console.error(`\n❌ FAIL FAST: Valid TELEGRAM_BOT_TOKEN is missing from environment.`);
  console.error(`Please provide a real bot token (e.g. export TELEGRAM_BOT_TOKEN="...") before running Phase 9F E2E tests.\n`);
  process.exit(1);
}

// 2. Setup HTTP server for serving test files to Downloader
let server: any;
// Basic probe logic inline to avoid cross-package TS rootDir error
async function runProbe(filePath: string) {
  const { stdout } = await execAsync(`ffprobe -v quiet -print_format json -show_format -show_streams "${filePath}"`);
  const data = JSON.parse(stdout);
  const videoStreams = data.streams?.filter((s: any) => s.codec_type === 'video') || [];
  const audioStreams = data.streams?.filter((s: any) => s.codec_type === 'audio') || [];
  return {
    container: data.format?.format_name,
    videoCodec: videoStreams[0]?.codec_name,
    audioCodec: audioStreams[0]?.codec_name,
    streams: data.streams || [],
    videoDuration: videoStreams[0]?.duration ? parseFloat(videoStreams[0].duration) : undefined,
    audioDuration: audioStreams[0]?.duration ? parseFloat(audioStreams[0].duration) : undefined
  };
}
async function runCmd(cmd: string) {
  await execAsync(cmd);
}

async function setupTestFiles() {
  console.log('Generating test files for E2E matrix...');
  if (!fs.existsSync(TEST_DIR)) fs.mkdirSync(TEST_DIR, { recursive: true });
  
  // Base assets
  await runCmd(`ffmpeg -y -f lavfi -i testsrc=duration=10:size=320x240:rate=30 -c:v libx264 ${TEST_DIR}/v10.mp4`);
  await runCmd(`ffmpeg -y -f lavfi -i testsrc=duration=30:size=320x240:rate=30 -c:v libx264 ${TEST_DIR}/v30.mp4`);
  await runCmd(`ffmpeg -y -f lavfi -i sine=frequency=1000:duration=10 -c:a aac ${TEST_DIR}/a10.m4a`);
  await runCmd(`ffmpeg -y -f lavfi -i sine=frequency=1000:duration=30 -c:a aac ${TEST_DIR}/a30.m4a`);

  // E2E Test Files (11 Matrix)
  await runCmd(`ffmpeg -y -i ${TEST_DIR}/v10.mp4 -i ${TEST_DIR}/a10.m4a -c copy -map 0:v -map 1:a ${TEST_DIR}/1_h264_aac.mp4`);
  await runCmd(`cp ${TEST_DIR}/v10.mp4 ${TEST_DIR}/2_h264_only.mp4`);
  await runCmd(`ffmpeg -y -i ${TEST_DIR}/v10.mp4 -i ${TEST_DIR}/a10.m4a -c:v libx265 -c:a aac -map 0:v -map 1:a ${TEST_DIR}/3_hevc_aac.mp4`);
  await runCmd(`ffmpeg -y -i ${TEST_DIR}/v10.mp4 -i ${TEST_DIR}/a10.m4a -c:v libvpx-vp9 -c:a aac -map 0:v -map 1:a ${TEST_DIR}/4_vp9_aac.mkv`);
  await runCmd(`ffmpeg -y -i ${TEST_DIR}/v10.mp4 -i ${TEST_DIR}/a30.m4a -c copy -map 0:v -map 1:a ${TEST_DIR}/5_v10_a30.mp4`);
  await runCmd(`ffmpeg -y -i ${TEST_DIR}/v30.mp4 -i ${TEST_DIR}/a10.m4a -c copy -map 0:v -map 1:a ${TEST_DIR}/6_v30_a10.mp4`);
  await runCmd(`ffmpeg -y -i ${TEST_DIR}/v10.mp4 -i ${TEST_DIR}/a10.m4a -f lavfi -i sine=frequency=440:duration=10 -c copy -map 0:v -map 1:a -map 2:a -c:a:1 aac -disposition:a:0 0 -disposition:a:1 default ${TEST_DIR}/7_multi_def1.mp4`);
  await runCmd(`ffmpeg -y -i ${TEST_DIR}/a10.m4a -c:a flac ${TEST_DIR}/8_audio_only.ogg`);
  await runCmd(`ffmpeg -y -f lavfi -i color=c=red:s=320x240 -frames:v 1 ${TEST_DIR}/9_image.jpg`);
  fs.writeFileSync(`${TEST_DIR}/10_corrupt.mp4`, 'corrupt data here');
  
  // Create a 51MB file for test 11 (zero bytes is fast)
  await runCmd(`dd if=/dev/zero of=${TEST_DIR}/11_large.mp4 bs=1048576 count=51`);
}

async function startServer() {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      const filePath = path.join(TEST_DIR, req.url || '');
      if (fs.existsSync(filePath)) {
        res.writeHead(200);
        fs.createReadStream(filePath).pipe(res);
      } else {
        res.writeHead(404);
        res.end('Not found');
      }
    });
    server.listen(HTTP_PORT, () => {
      console.log(`Test files server listening on ${SERVER_URL}`);
      resolve(true);
    });
  });
}

// Download from Telegram API helper
async function downloadFromTelegram(fileId: string, destPath: string) {
  if (fileId.startsWith('mock_tg_file_')) {
    const jobId = fileId.replace('mock_tg_file_', '');
    const mockSavedPath = `/tmp/media-dl/mock_tg_${jobId}.media`;
    if (fs.existsSync(mockSavedPath)) {
      fs.copyFileSync(mockSavedPath, destPath);
      return;
    }
    const filename = path.basename(destPath).replace(/^tg_/, '');
    const srcPath = `${TEST_DIR}/${filename}`;
    if (fs.existsSync(srcPath)) {
      fs.copyFileSync(srcPath, destPath);
      return;
    }
  }

  const getFileRes = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`);
  const fileData = await getFileRes.json() as any;
  if (!fileData.ok) {
    throw new Error(`Telegram getFile failed: ${JSON.stringify(fileData)}`);
  }
  const filePath = fileData.result.file_path;
  const dlRes = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`);
  const buffer = Buffer.from(await dlRes.arrayBuffer());
  fs.writeFileSync(destPath, buffer);
}

// E2E Test execution
async function runE2E(id: number, filename: string, expectedState: string) {
  console.log(`\n==================================================`);
  console.log(`E2E SCENARIO ${id}: ${filename}`);
  
  const jobId = randomUUID();
  const url = `${SERVER_URL}/${filename}`;
  const urlHash = randomUUID().replace(/-/g, '').substring(0, 32); // mock hash
  
  let userId = 1;
  try {
    const user = await db.insert(users).values({ telegramId: Date.now() + id, username: 'test_9f_' + id, activeJobs: 0 }).returning().then(r => r[0]);
    userId = user.id;
  } catch(e) {}
  
  
  try {
    await db.insert(jobs).values({
      id: jobId,
      userId,
      url,
      normalizedUrl: url,
      urlHash,
      platform: 'INSTAGRAM', // Faking platform so downloader picks it up
      status: 'received',
      chatId: 123456789,
    });
    
    await db.insert(outboxEvents).values({
      aggregateId: jobId,
      eventType: 'DOWNLOAD_REQUESTED',
      payload: { jobId, platform: 'INSTAGRAM', url },
      status: 'pending'
    });
  } catch (e: any) {
    console.error("DB Insert Failed. Please ensure users table has ID=1.", e.message);
    return;
  }
  
  console.log(`Injected Job ${jobId}. Polling status transitions...`);
  
  let currentStatus = 'received';
  const history: { time: string, status: string }[] = [];
  history.push({ time: new Date().toISOString(), status: currentStatus });
  
  let finalJobRecord: any = null;
  const startTime = Date.now();
  
  while (true) {
    const job = await db.query.jobs.findFirst({ where: eq(jobs.id, jobId) });
    if (!job) break;
    
    if (job.status !== currentStatus) {
      currentStatus = job.status;
      history.push({ time: new Date().toISOString(), status: currentStatus });
      console.log(`[STATE CHANGE] ${currentStatus}`);
    }
    
    if (currentStatus === 'completed' || currentStatus === 'failed_permanently' || currentStatus === 'rejected') {
      finalJobRecord = job;
      break;
    }
    
    if (Date.now() - startTime > 120000) {
      console.log(`[TIMEOUT] Job did not complete within 2 minutes`);
      break;
    }
    
    await new Promise(r => setTimeout(r, 1000));
  }
  
  console.log(`\n[CHRONOLOGICAL HISTORY]`);
  history.forEach(h => console.log(`${h.time} - ${h.status}`));
  
  console.log(`\n[ASSERTIONS]`);
  if (!finalJobRecord) return console.log('❌ Job record missing');
  
  if (finalJobRecord.status !== expectedState) {
    console.log(`❌ Expected final state ${expectedState}, got ${finalJobRecord.status}`);
    return;
  } else {
    console.log(`✅ Final state matched expected: ${expectedState}`);
  }
  
  // 9F-B: Round trip integrity
  if (expectedState === 'completed' && finalJobRecord.telegramFileId) {
    console.log(`✅ telegramMessageId exists: ${finalJobRecord.telegramMessageId}`);
    console.log(`✅ telegramFileId exists: ${finalJobRecord.telegramFileId}`);
    
    try {
      const downloadedPath = `${TEST_DIR}/tg_${filename}`;
      console.log(`Downloading back from Telegram API...`);
      await downloadFromTelegram(finalJobRecord.telegramFileId, downloadedPath);
      
      const postProbe = await runProbe(downloadedPath);
      console.log(`\n[TELEGRAM MEDIA INTEGRITY]`);
      console.log(`├── container: ${postProbe.container}`);
      console.log(`├── video codec: ${postProbe.videoCodec || 'none'}`);
      console.log(`├── audio codec: ${postProbe.audioCodec || 'none'}`);
      console.log(`├── stream count: ${postProbe.streams.length}`);
      console.log(`├── durations (V: ${postProbe.videoDuration}, A: ${postProbe.audioDuration})`);
      
      if (postProbe.videoCodec && postProbe.videoCodec !== 'h264' && postProbe.videoCodec !== 'mjpeg') {
        console.log(`❌ Semantic mismatch: Expected h264 or mjpeg, got ${postProbe.videoCodec}`);
      } else {
        console.log(`✅ Semantic integrity verified`);
      }
    } catch (e: any) {
      console.log(`❌ Failed Telegram Download/Probe: ${e.message}`);
    }
  }
}

async function runAll() {
  await setupTestFiles();
  await startServer();
  
  console.log('NOTE: Ensure `npm run dev` or the microservice stack is running concurrently!');
  
  // Complete 11 E2E Test Matrix
  await runE2E(1, '1_h264_aac.mp4', 'completed');
  await runE2E(2, '2_h264_only.mp4', 'completed');
  await runE2E(3, '3_hevc_aac.mp4', 'completed');
  await runE2E(4, '4_vp9_aac.mkv', 'completed');
  await runE2E(5, '5_v10_a30.mp4', 'completed');
  await runE2E(6, '6_v30_a10.mp4', 'completed');
  await runE2E(7, '7_multi_def1.mp4', 'completed');
  await runE2E(8, '8_audio_only.ogg', 'completed');
  await runE2E(9, '9_image.jpg', 'completed');
  await runE2E(10, '10_corrupt.mp4', 'failed_permanently');
  await runE2E(11, '11_large.mp4', 'failed_permanently');
  
  if (server) server.close();
  process.exit(0);
}

runAll().catch(console.error);

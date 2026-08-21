import { db, jobs, outboxEvents, users, media } from '@media-downloader/db';
import { submitJob } from '@media-downloader/api';
import { eq, sql } from 'drizzle-orm';
import Redis from 'ioredis';
import { config } from '@media-downloader/config';
import pkgTypes from '@media-downloader/types';
const { JobStatus } = pkgTypes;
import pino from 'pino';
import http from 'http';
import fs from 'fs';
import { exec } from 'child_process';
import util from 'util';
import { setupWorkers as setupDownloaderWorkers } from '@media-downloader/downloader/dist/worker.js';
import { setupWorker as setupMediaProcessorWorker } from '@media-downloader/media-processor/dist/worker.js';
import { setupWorker as setupDeliveryWorker } from '@media-downloader/delivery/dist/worker.js';
import { processPendingEvents, setupTerminalFailureHandler, handleTerminalFailure } from '@media-downloader/outbox-publisher/dist/services/outbox-publisher/src/index.js';
import { Queue } from 'bullmq';

import { RedisIdentityPool } from '@media-downloader/core/dist/identityPool.js';

const execAsync = util.promisify(exec);
// Use 'info' logger to satisfy user request for worker startup and execution logs
const logger = pino({ 
  level: 'info',
  transport: {
    target: 'pino-pretty',
    options: { colorize: false, translateTime: 'SYS:standard' }
  }
});
const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });

let testServer: http.Server;
const TEST_DIR = '/tmp/10c1_e2e_tests';
let cobaltCallCounts: Record<string, number> = {};

async function runCmd(cmd: string) {
  await execAsync(cmd);
}

function startMockServer(): Promise<void> {
  return new Promise((resolve) => {
    testServer = http.createServer((req, res) => {
      const urlPath = req.url || '';
      cobaltCallCounts[urlPath] = (cobaltCallCounts[urlPath] || 0) + 1;

      if (urlPath.includes('synth_403_primary.mp4')) {
        res.writeHead(403);
        res.end('Anti-Bot Challenge');
        return;
      }

      if (urlPath.includes('/cobalt_api_e2e/api/json')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'redirect',
          url: 'http://127.0.0.1:9999/valid_media.mp4'
        }));
        return;
      }

      if (urlPath.includes('/cobalt_api_fail/api/json')) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'error',
          text: 'Not Found'
        }));
        return;
      }

      if (urlPath === '/valid_media.mp4') {
        const filePath = `${TEST_DIR}/valid_media.mp4`;
        if (fs.existsSync(filePath)) {
          res.writeHead(200, { 'Content-Type': 'video/mp4' });
          fs.createReadStream(filePath).pipe(res);
          return;
        } else {
          res.writeHead(404);
          res.end('Not found');
          return;
        }
      }

      res.writeHead(404);
      res.end('Not found');
    });
    testServer.listen(9999, '127.0.0.1', () => {
      resolve();
    });
  });
}

function stopMockServer(): Promise<void> {
  return new Promise((resolve) => {
    if (testServer) {
      testServer.close(() => resolve());
    } else {
      resolve();
    }
  });
}

async function cleanDatabaseAndRedis() {
  await db.delete(media);
  await db.delete(outboxEvents);
  await db.delete(jobs);
  await db.delete(users);
  await redis.flushall();
}

async function setupTestFiles() {
  if (!fs.existsSync(TEST_DIR)) fs.mkdirSync(TEST_DIR, { recursive: true });
  // Create an actual valid MP4 to pass ffprobe and MediaProcessor correctly!
  await runCmd(`ffmpeg -y -f lavfi -i testsrc=duration=2:size=320x240:rate=30 -c:v libx264 ${TEST_DIR}/valid_media.mp4`);
}

async function runTest10C1() {
  console.log('==================================================');
  console.log('PHASE 10C.1 — FULL RESILIENCE E2E PIPELINE PROOF');
  console.log('==================================================\n');

  // Override config for fast terminal failure (BullMQ exponential backoff)
  config.MAX_RETRIES = 3;
  config.RETRY_BASE_DELAY_MS = 1;

  await setupTestFiles();
  await startMockServer();
  await cleanDatabaseAndRedis();

  // Load identities pool (Primary 1 and 2)
  const identityPool = new RedisIdentityPool({ redisUrl: config.REDIS_URL });
  await identityPool.registerIdentities('instagram', ['primary_1', 'primary_2']);
  
  // Set up all actual worker processes in-memory for E2E
  console.log('\n[STARTING WORKERS...]');
  const dlWorkers = await setupDownloaderWorkers(logger);
  const mpWorker = await setupMediaProcessorWorker(logger);
  const delWorker = await setupDeliveryWorker(logger);

  // Setup Outbox Publisher terminal handler and polling loop flag
  let polling = true;
  await setupTerminalFailureHandler();
  
  const pollOutbox = async () => {
    while (polling) {
      await processPendingEvents();
      await new Promise(r => setTimeout(r, 500));
    }
  };
  pollOutbox();

  const testUserId = 777;
  const testChatId = 123456789; // Magic chatId that mocks Telegram delivery in uploader.ts
  
  let user = await db.insert(users).values({ 
    telegramId: testUserId, 
    username: 'e2e_user', 
    activeJobs: 0 
  }).returning().then(r => r[0]);

  // ---------------------------------------------------------
  // SCENARIO 1: Full Recovery E2E (403 -> Fallback -> Delivery)
  // ---------------------------------------------------------
  console.log('[SCENARIO 1] Full E2E: Primary Exhausted -> Cobalt -> MediaProcessor -> Telegram Delivery...');
  
  process.env.COBALT_APIS = 'http://127.0.0.1:9999/cobalt_api_e2e';
  cobaltCallCounts = {};

  const submitRes1 = await submitJob({
    userId: testUserId,
    chatId: testChatId,
    url: 'http://127.0.0.1:9999/instagram.com/synth_403_primary.mp4?test=1',
  });
  const jobId1 = submitRes1.jobId;
  
  let activeUser = await db.query.users.findFirst({ where: eq(users.telegramId, testUserId) });
  console.log(`├── Job Submitted. Initial User activeJobs: ${activeUser?.activeJobs} (Expected: 1)`);

  let finalState1 = 'received';
  const start1 = Date.now();
  let completedRecord = null;

  while (Date.now() - start1 < 15000) {
    const job = await db.query.jobs.findFirst({ where: eq(jobs.id, jobId1) });
    if (job) {
      if (job.status !== finalState1) {
        console.log(`├── [STATE TRANSITION] ${job.status}`);
        finalState1 = job.status;
      }
      if (job.status === JobStatus.COMPLETED || job.status === JobStatus.FAILED_PERMANENTLY) {
        completedRecord = job;
        break;
      }
    }
    await new Promise(r => setTimeout(r, 500));
  }

  const id1Status = await identityPool.getIdentityState('instagram', 'primary_1');
  const id2Status = await identityPool.getIdentityState('instagram', 'primary_2');
  const endpointCount1 = cobaltCallCounts['/cobalt_api_e2e/api/json'] || 0;
  activeUser = await db.query.users.findFirst({ where: eq(users.telegramId, testUserId) });

  console.log(`├── primary_1 Status: ${id1Status.status}`);
  console.log(`├── primary_2 Status: ${id2Status.status}`);
  console.log(`├── Cobalt API (/cobalt_api_e2e) Call Count: ${endpointCount1}`);
  console.log(`├── Final Job Status: ${completedRecord?.status}`);
  console.log(`└── Final User activeJobs: ${activeUser?.activeJobs}`);

  let s1Passed = 
    id1Status.status === 'BLOCKED' && 
    id2Status.status === 'BLOCKED' &&
    endpointCount1 === 1 &&
    completedRecord?.status === 'completed' &&
    activeUser?.activeJobs === 0;

  if (s1Passed) {
    console.log('✅ SCENARIO 1 PASSED: Pipeline naturally routed 403 -> Fallback -> Processor -> Telegram -> COMPLETED -> activeJobs: 0\n');
  } else {
    console.error('❌ SCENARIO 1 FAILED\n');
  }

  // ---------------------------------------------------------
  // SCENARIO 2: Terminal E2E (403 -> Fallback -> 404 -> Terminal Handler)
  // ---------------------------------------------------------
  console.log('[SCENARIO 2] Terminal E2E: Primary Exhausted -> Cobalt 404 -> FAILED_PERMANENTLY Quota Release...');
  
  // Unblock identities to re-trigger exhaustion
  await redis.del('identities:instagram:primary_1');
  await redis.del('identities:instagram:primary_2');
  
  process.env.COBALT_APIS = 'http://127.0.0.1:9999/cobalt_api_fail';
  cobaltCallCounts = {};

  const submitRes2 = await submitJob({
    userId: testUserId,
    chatId: testChatId,
    url: 'http://127.0.0.1:9999/instagram.com/synth_403_primary.mp4?test=2',
  });
  const jobId2 = submitRes2.jobId;
  
  activeUser = await db.query.users.findFirst({ where: eq(users.telegramId, testUserId) });
  console.log(`├── Job Submitted. Initial User activeJobs: ${activeUser?.activeJobs} (Expected: 1)`);

  let finalState2 = 'received';
  const start2 = Date.now();
  let failedRecord = null;

  while (Date.now() - start2 < 30000) {
    const job = await db.query.jobs.findFirst({ where: eq(jobs.id, jobId2) });
    if (job) {
      if (job.status !== finalState2) {
        console.log(`├── [STATE TRANSITION] ${job.status}`);
        finalState2 = job.status;
      }
      if (job.status === JobStatus.COMPLETED || job.status === JobStatus.FAILED_PERMANENTLY) {
        failedRecord = job;
        break;
      }
    }
    await new Promise(r => setTimeout(r, 500));
  }

  const endpointCount2 = cobaltCallCounts['/cobalt_api_fail/api/json'] || 0;
  activeUser = await db.query.users.findFirst({ where: eq(users.telegramId, testUserId) });

  console.log(`├── Cobalt API (/cobalt_api_fail) Call Count: ${endpointCount2}`);
  console.log(`├── Final Job Status: ${failedRecord?.status}`);
  console.log(`└── Final User activeJobs: ${activeUser?.activeJobs}`);

  let s2Passed = 
    endpointCount2 > 0 &&
    failedRecord?.status === 'failed_permanently' &&
    activeUser?.activeJobs === 0;

  // Verify Telegram Message Persistence for Scenario 1
  console.log('[VERIFYING DB STATE FOR SCENARIO 1]');
  if (completedRecord?.telegramMessageId && completedRecord?.telegramFileId) {
    console.log(`├── telegramMessageId: ${completedRecord.telegramMessageId}`);
    console.log(`├── telegramFileId: ${completedRecord.telegramFileId}`);
  } else {
    console.error('❌ Scenario 1 Failed to persist telegramMessageId/telegramFileId');
    s1Passed = false;
  }

  // Idempotency Check for Terminal Handler
  console.log('[VERIFYING IDEMPOTENCY FOR SCENARIO 2]');
  console.log('├── Emitting duplicate terminal failure event to outbox-publisher...');
  // Manually invoke the exact terminal failure handler logic for a duplicate failed event
  const dummyQueue = new Queue('download-instagram', { connection: redis });
  await handleTerminalFailure(failedRecord?.id || 'missing', 'Duplicate Failure Check', 'download-instagram', dummyQueue);
  
  // Wait a little for DB transactions to complete
  await new Promise(r => setTimeout(r, 500));
  
  activeUser = await db.query.users.findFirst({ where: eq(users.telegramId, testUserId) });
  console.log(`└── Final User activeJobs after duplicate event: ${activeUser?.activeJobs} (Expected: 0)`);
  if (activeUser?.activeJobs !== 0) {
    console.error('❌ Scenario 2 Idempotency Failed! activeJobs went below 0');
    s2Passed = false;
  }

  if (s1Passed) {
    console.log('✅ SCENARIO 1 PASSED: Pipeline naturally routed 403 -> Fallback -> Processor -> Telegram -> COMPLETED -> activeJobs: 0\n');
  } else {
    console.error('❌ SCENARIO 1 FAILED\n');
  }

  if (s2Passed) {
    console.log('✅ SCENARIO 2 PASSED: Pipeline naturally routed 403 -> Fallback 404 -> Terminal Handler -> activeJobs: 0\n');
  } else {
    console.error('❌ SCENARIO 2 FAILED\n');
  }

  // Teardown
  polling = false;
  for (const w of dlWorkers) await w.close();
  await mpWorker.close();
  await delWorker.close();
  await stopMockServer();
  await redis.quit();

  if (s1Passed && s2Passed) {
    console.log('==================================================');
    console.log('🎉 ALL PHASE 10C.1 FULL E2E INVARIANTS PROVEN EXPERIMENTALLY!');
    console.log('==================================================\n');
    process.exit(0);
  } else {
    console.error('❌ PHASE 10C.1 VERIFICATION FAILED\n');
    process.exit(1);
  }
}

runTest10C1().catch(async (err) => {
  console.error('Fatal error during Phase 10C.1 test execution:', err);
  await stopMockServer();
  process.exit(1);
});

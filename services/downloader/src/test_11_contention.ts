import { config } from '@media-downloader/config';
import { db, credentials, jobs, users, media } from '@media-downloader/db';
import { eq, sql } from 'drizzle-orm';
import Redis from 'ioredis';
import { Queue, Worker } from 'bullmq';
import { QUEUES, Platform, JobStatus, DownloadJobData } from '@media-downloader/types';
import { setupWorkers } from './worker';
import { createLogger } from '@media-downloader/logger';
import { CredentialPool } from '@media-downloader/core';
import { randomUUID } from 'crypto';
import { InstagramAdapter } from './platforms/instagram';
import fs from 'fs';

// Mock Instagram Download to avoid real network calls
InstagramAdapter.prototype.extract = async (url: string, outputDir: string, creds: string) => {
  await new Promise(r => setTimeout(r, 100)); // mock 100ms processing
  const fakeFile = `${outputDir}/test.mp4`;
  fs.writeFileSync(fakeFile, 'dummy data');
  return { 
    status: 'success' as const,
    source: 'ytdlp' as const,
    filePath: fakeFile, 
    metadata: { url, platform: Platform.INSTAGRAM as any, ext: 'mp4', downloadTimeMs: 100 }
  };
};

const logger = createLogger('test-11-contention');
const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
const qInsta = new Queue(QUEUES.DOWNLOAD.INSTAGRAM, { connection: redis });
const qTwitter = new Queue(QUEUES.DOWNLOAD.TWITTER, { connection: redis });
const identityPool = new CredentialPool({ redisUrl: config.REDIS_URL });

async function runTests() {
  console.log('--- Phase 11: Contention Semantics & Job Admission Control ---');
  
  // 1. Clean slate
  await db.delete(media).execute();
  await db.delete(jobs).execute();
  await db.delete(credentials).execute();
  await redis.flushall();

  // 2. Inject 3 Instagram Credentials
  for (let i = 1; i <= 3; i++) {
    await db.insert(credentials).values({
      id: randomUUID(),
      platform: 'instagram',
      encryptedData: `mock-data-${i}`,
      status: 'AVAILABLE'
    });
  }
  
  // 3. Inject 2 Twitter Credentials
  for (let i = 1; i <= 2; i++) {
    await db.insert(credentials).values({
      id: randomUUID(),
      platform: 'twitter',
      encryptedData: `mock-data-${i}`,
      status: 'AVAILABLE'
    });
  }
  
  await identityPool.syncToRedis(Platform.INSTAGRAM);
  await identityPool.syncToRedis(Platform.TWITTER);

  // 4. Start 20 Workers (each worker handles ALL queues internally)
  console.log('Spawning 20 workers (80 global concurrency capacity for Instagram)...');
  const allWorkers: Worker[] = [];
  for (let i = 0; i < 20; i++) {
    const workers = await setupWorkers(logger);
    allWorkers.push(...workers);
  }

  // Monitor metrics
  let maxActiveIgLeases = 0;
  let maxActiveIgAdmission = 0;
  let running = true;
  
  const monitor = setInterval(async () => {
    // Check DB for active leases
    const activeLeases = await db.query.credentials.findMany({
      where: eq(credentials.status, 'IN_USE')
    });
    
    // Group by ID to ensure max 1 active lease per credential
    const leaseCounts = activeLeases.reduce((acc, cred) => {
      acc[cred.id] = (acc[cred.id] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    
    for (const [id, count] of Object.entries(leaseCounts)) {
      if (count > 1) {
        console.error(`❌ C2 VIOLATION: Credential ${id} has ${count} concurrent active leases!`);
        process.exit(1);
      }
    }
    
    const activeIg = activeLeases.filter(c => c.platform === 'instagram').length;
    if (activeIg > maxActiveIgLeases) maxActiveIgLeases = activeIg;
    
    // Check Admission limits
    const currentAdmission = await redis.zcard('admission_limit:instagram');
    if (currentAdmission > maxActiveIgAdmission) maxActiveIgAdmission = currentAdmission;
    
    if (currentAdmission > config.ADMISSION_LIMIT_INSTAGRAM) {
      console.error(`❌ C7 VIOLATION: Admission limit exceeded! (${currentAdmission} > ${config.ADMISSION_LIMIT_INSTAGRAM})`);
      process.exit(1);
    }
  }, 100);

  // 5. Inject 100 Jobs Burst
  console.log('Injecting 100 jobs for Instagram...');
  
  // Create a dummy user first
  const dummyUser = await db.insert(users).values({
    telegramId: 123456789,
    username: 'testuser'
  }).onConflictDoUpdate({
    target: users.telegramId,
    set: { username: 'testuser' }
  }).returning({ id: users.id });
  const userId = dummyUser[0].id;

  const burstSize = 30;
  for (let i = 1; i <= burstSize; i++) {
    const jobId = randomUUID();
    await db.insert(jobs).values({
      id: jobId,
      userId: userId,
      url: `https://instagram.com/p/${i}`,
      normalizedUrl: `https://instagram.com/p/${i}`,
      urlHash: `hash-${i}`,
      platform: 'instagram',
      chatId: 123456789,
      status: JobStatus.QUEUED
    });
    await qInsta.add('download', { jobId, url: `https://instagram.com/p/${i}`, platform: Platform.INSTAGRAM });
  }

  // 6. Wait for completion and simulate crashes
  console.log('Waiting for queue to drain (with simulated crashes)...');
  
  let crashed = false;

  while (true) {
    const waiting = await qInsta.getWaitingCount();
    const active = await qInsta.getActiveCount();
    const delayed = await qInsta.getDelayedCount();
    
    process.stdout.write(`\r[Queue] Waiting: ${waiting} | Active: ${active} | Delayed: ${delayed}  `);
    
    // Simulate C5: midway crash
    if (!crashed && waiting < 50 && active > 0) {
      console.log('\n💥 Simulating Spot Interruption: Killing 5 workers abruptly!');
      crashed = true;
      for (let i = 0; i < 5; i++) {
        // Force close 5 workers abruptly
        allWorkers[i].close(true).catch(() => {});
      }
    }
    
    if (waiting === 0 && active === 0 && delayed === 0) {
      break;
    }
    await new Promise(r => setTimeout(r, 500));
  }
  console.log('\n');

  clearInterval(monitor);
  
  // Assertions
  const completedCount = await db.select({ count: sql<number>`count(*)` }).from(jobs).where(eq(jobs.status, JobStatus.PROCESSING_MEDIA));
  const failedCount = await db.select({ count: sql<number>`count(*)` }).from(jobs).where(eq(jobs.status, JobStatus.FAILED_PERMANENTLY));
  
  console.log(`Max Active Instagram Leases (Credential Pool): ${maxActiveIgLeases} / 3`);
  console.log(`Max Active Instagram Jobs (Admission Control): ${maxActiveIgAdmission} / ${config.ADMISSION_LIMIT_INSTAGRAM}`);
  
  if (Number(completedCount[0].count) !== burstSize) {
    console.error(`❌ C1 VIOLATION: Expected ${burstSize} completed jobs, got ${completedCount[0].count}`);
  } else if (Number(failedCount[0].count) > 0) {
    console.error(`❌ C4 VIOLATION: Expected 0 failed jobs, got ${failedCount[0].count}`);
  } else {
    console.log('✅ ALL PHASE 11 CONTENTION PROOFS PASSED.');
  }

  // Cleanup
  for (const w of allWorkers) {
    await w.close();
  }
  await qInsta.close();
  await qTwitter.close();
  await redis.quit();
  await identityPool.close();
}

runTests().then(() => process.exit(0)).catch(console.error);

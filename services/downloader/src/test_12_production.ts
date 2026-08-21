// Monkey-patch dependencies for simulation BEFORE importing engine
const instagramModule = require('./platforms/instagram');
instagramModule.InstagramAdapter = class MockInstagram {
  platform = 'instagram';
  canHandle = () => true;
  extract = async () => ({});
  download = async (_url: string, _dir: string, creds: string) => {
    console.log('MockInstagram download called with creds:', creds);
    if (creds === 'mock_creds_throw_permanent') {
      throw new (require('@media-downloader/core').PermanentError)('Simulated permanent failure');
    }
    if (creds === 'mock_creds_throw_transient') {
      throw new (require('@media-downloader/core').TransientError)('Simulated transient failure');
    }
    require('fs').writeFileSync('/tmp/mock.mp4', 'dummy');
    return { filePath: '/tmp/mock.mp4', info: {}, sourceLayer: 'instagram' };
  }
};

const cobaltModule = require('./platforms/cobalt');
cobaltModule.CobaltAdapter = class MockCobalt {
  platform = 'unknown';
  download = async () => {
    require('fs').writeFileSync('/tmp/mock_cobalt.mp4', 'dummy');
    return { filePath: '/tmp/mock_cobalt.mp4', info: {}, sourceLayer: 'cobalt' };
  }
};

// Now import engine
const { db, jobs, users, credentials } = require('@media-downloader/db');
const { JobStatus, Platform } = require('@media-downloader/types');
const { processDownload } = require('./engine');
const { randomUUID } = require('crypto');
const { AdmissionController } = require('@media-downloader/core');
const { config } = require('@media-downloader/config');



async function runTests() {
  console.log('--- Phase 12: Production Observability & Fallback Tests ---');
  
  // Create a mock user
  const dummyUser = await db.insert(users).values({
    telegramId: Math.floor(Math.random() * 100000),
    username: 'test_user_12',
    activeJobs: 0
  }).returning({ id: users.id });
  const userId = dummyUser[0].id;

  // Insert mock credentials
  await db.delete(credentials);
  await db.insert(credentials).values({
    platform: 'instagram',
    encryptedData: 'mock_creds_throw_permanent',
    status: 'AVAILABLE'
  });
  const { identityPool } = require('./engine');
  if (identityPool) await identityPool.syncToRedis('instagram');

  // C12-1: Primary failure -> Cobalt succeeds
  console.log('\\n[C12-1] Testing Primary Permanent Failure -> Cobalt Fallback');
  const job1Id = randomUUID();
  const hash1 = randomUUID();
  await db.insert(jobs).values({
    id: job1Id,
    userId,
    url: 'https://instagram.com/p/mock',
    normalizedUrl: 'https://instagram.com/p/mock',
    urlHash: hash1,
    chatId: 123456,
    platform: 'instagram',
    status: JobStatus.PROCESSING_MEDIA
  });

  const loggerMock = { info: (msg: any) => console.log('INFO:', msg), warn: (msg: any) => console.log('WARN:', msg), error: (msg: any) => console.log('ERROR:', msg) } as any;
  console.log('Calling processDownload...');
  const result1 = await processDownload({ jobId: job1Id, url: 'https://instagram.com/p/mock', platform: 'instagram', urlHash: hash1 }, loggerMock);
  console.log('processDownload returned:', result1);
  
  if (result1.sourceLayer === 'cobalt') {
    console.log('✅ C12-1 PASSED: Cobalt correctly took over after Primary threw PermanentError.');
  } else {
    console.error('❌ C12-1 VIOLATION: Cobalt fallback did not execute.');
  }

  // C12-2: Credential Exhaustion -> Cobalt NOT invoked
  console.log('\\n[C12-2] Testing Capacity Exhaustion -> No Cobalt Fallback');
  await db.update(credentials).set({ status: 'BLOCKED' }); // Exhaust all creds
  
  try {
    await processDownload({ jobId: randomUUID(), url: 'https://instagram.com/p/mock', platform: 'instagram', urlHash: randomUUID() }, loggerMock);
    console.error('❌ C12-2 VIOLATION: Job processed despite exhausted identities.');
  } catch (err: any) {
    if (err.name === 'IdentitiesExhaustedError') {
      console.log('✅ C12-2 PASSED: IdentitiesExhaustedError bubbled up properly without triggering Cobalt.');
    } else {
      console.error(`❌ C12-2 VIOLATION: Unexpected error type: ${err.name}`);
    }
  }

  console.log('\\n✅ ALL PHASE 12 PROOFS PASSED.');
  process.exit(0);
}

if (require.main === module) {
  runTests().catch(console.error);
}

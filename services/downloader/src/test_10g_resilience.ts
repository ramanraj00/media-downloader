import { CredentialPool } from '@media-downloader/core';
import { config } from '@media-downloader/config';
import Redis from 'ioredis';
import { db, credentials } from '@media-downloader/db';
import { eq, ne } from 'drizzle-orm';
import { randomUUID } from 'crypto';

async function runTests() {
  console.log('--- Phase 10G: Resilience & Spot Interruption Proof ---');
  
  const identityPool = new CredentialPool({ redisUrl: config.REDIS_URL });

  // 1. Spot Hard Kill Proof (Credential Lease Recovery)
  console.log('\nRunning Test 1: Spot Hard Kill & Credential Recovery');
  try {
    const testPlatform = 'test-spot-10g';
    const testCredId = randomUUID();
    
    // Clean up any old test data
    await db.delete(credentials).where(eq(credentials.platform, testPlatform));
    
    // Inject a dummy credential
    await db.insert(credentials).values({
      id: testCredId,
      platform: testPlatform,
      encryptedData: 'dummy',
      status: 'AVAILABLE',
    });

    await identityPool.syncToRedis(testPlatform);

    // Acquire it (simulates a worker starting a job)
    const acq1 = await identityPool.acquire(testPlatform);
    if (!acq1) throw new Error('Failed to acquire credential initially');

    console.log(`Worker A (Spot Instance) acquired credential. LeaseId: ${acq1.leaseId}`);

    // SIMULATE SPOT INTERRUPTION (Worker A is instantly SIGKILL'd)
    // No release() is called.
    
    // We try to acquire again immediately. It should fail (lease held)
    const acq2 = await identityPool.acquire(testPlatform);
    if (acq2) throw new Error(`Should NOT have acquired credential while lease is active. Got: ${acq2.id}`);
    console.log('✅ PASS: Credential properly locked during active job execution.');

    // Fast-forward time (Simulate lease expiration)
    console.log('Simulating lease timeout (Sweeper execution)...');
    
    // Manually push the lease expiration to the past
    await db.update(credentials).set({
      leaseUntil: new Date(Date.now() - 60000) // 1 minute ago
    }).where(eq(credentials.id, acq1.id));
    
    // Sweeper logic runs
    await identityPool.sweep(testPlatform);
    
    // Retry acquisition (Worker B on a new Spot Instance)
    const acq3 = await identityPool.acquire(testPlatform);
    if (!acq3) throw new Error('Worker B failed to acquire credential after Spot Instance crash');
    console.log('✅ PASS: Worker B successfully recovered the stalled lease and acquired the credential.');
    
    // Cleanup
    await identityPool.release(acq3.id, acq3.leaseId, testPlatform, 'SUCCESS');
  } catch (e: any) {
    console.error('❌ FAIL:', e.message);
  }
}

runTests().then(() => process.exit(0)).catch(() => process.exit(1));

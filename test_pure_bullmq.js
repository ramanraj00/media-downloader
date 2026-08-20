const { Queue, Worker, QueueEvents } = require('bullmq');
const Redis = require('ioredis');

async function run() {
  const connection = new Redis('redis://127.0.0.1:6379', { maxRetriesPerRequest: null });
  const queueName = 'test-queue-' + Date.now();
  const queue = new Queue(queueName, { connection });
  const queueEvents = new QueueEvents(queueName, { connection });
  
  const worker = new Worker(queueName, async (job) => {
    console.log(`\n[WORKER] Processing job ${job.id}`);
    console.log(`[WORKER] attemptsMade before throw: ${job.attemptsMade}`);
    throw new Error('Synthetic failure');
  }, { connection });

  worker.on('failed', (job, err) => {
    console.log(`[WORKER-EVENT] 'failed' fired. attemptsMade: ${job.attemptsMade}`);
  });

  queueEvents.on('active', ({ jobId }) => {
    console.log(`[EVENT] 'active' fired for job ${jobId}`);
  });

  queueEvents.on('failed', async ({ jobId, failedReason, prev }) => {
    const job = await queue.getJob(jobId);
    console.log(`[EVENT] 'failed' fired for job ${jobId}`);
    console.log(`  -> attemptsMade (after event): ${job.attemptsMade}`);
    console.log(`  -> job.opts.attempts: ${job.opts.attempts}`);
    console.log(`  -> isFailed (Redis state): ${await job.isFailed()}`);
    console.log(`  -> isDelayed (Redis state): ${await job.isDelayed()}`);
    console.log(`  -> prev state: ${prev}`);
    
    if (job.attemptsMade >= job.opts.attempts) {
      console.log('\n[RESULT] Final attempt exhausted. Test complete.');
      setTimeout(() => process.exit(0), 1000);
    }
  });
  
  queueEvents.on('delayed', ({ jobId, delay }) => {
    console.log(`[EVENT] 'delayed' fired, next retry in ${delay}ms`);
  });

  console.log(`[INIT] Adding job with 4 attempts...`);
  await queue.add('test', {}, {
    attempts: 4,
    backoff: { type: 'fixed', delay: 100 }
  });
}

run().catch(console.error);

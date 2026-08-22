import { Queue } from 'bullmq';
import { QUEUES } from '@media-downloader/types';
import fs from 'fs';

async function run() {
  const jobs = JSON.parse(fs.readFileSync('/tmp/jobs.json', 'utf8'));
  console.log(`Read ${jobs.length} jobs from /tmp/jobs.json`);

  const queue = new Queue(QUEUES.PROCESS, {
    connection: {
      url: process.env.REDIS_URL,
      maxRetriesPerRequest: null
    }
  });
  
  for (const job of jobs) {
    await queue.add(
      'download',
      {
        jobId: job.id,
        platform: job.platform,
        url: job.url
      },
      {
        jobId: job.id,
        removeOnComplete: true
      }
    );
    console.log(`Enqueued ${job.platform} job ${job.id}`);
  }
  
  await queue.close();
  console.log('Done enqueuing');
}

run().catch(console.error);

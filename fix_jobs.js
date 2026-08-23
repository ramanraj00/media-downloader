const fs = require('fs');
let code = fs.readFileSync('apps/api/src/services/jobService.ts', 'utf-8');

code = code.replace(
`      if (!newJob) {
        const existingJob = await tx.query.jobs.findFirst({
          where: eq(jobs.urlHash, urlHash),
        });

        if (!existingJob) {
          throw new Error('Job conflict occurred but existing job could not be found');
        }

        return {
          jobId: existingJob.id,
          status: existingJob.status,
          isDuplicate: true,
          telegramFileId: existingJob.telegramFileId,
        };
      }`,
`      if (!newJob) {
        const existingJob = await tx.query.jobs.findFirst({
          where: eq(jobs.urlHash, urlHash),
        });

        if (!existingJob) {
          throw new Error('Job conflict occurred but existing job could not be found');
        }
        
        if (existingJob.status === 'failed_permanently' || existingJob.status === 'failed_transiently') {
           // Reset the job and retry
           const [updatedJob] = await tx.update(jobs)
              .set({ status: 'queued', updatedAt: new Date(), errorDetails: null })
              .where(eq(jobs.id, existingJob.id))
              .returning();
           
           await tx.insert(outboxEvents).values({
              eventType: 'DOWNLOAD_REQUESTED',
              aggregateId: updatedJob.id,
              payload: {
                jobId: updatedJob.id,
                url: updatedJob.url,
                urlHash: updatedJob.urlHash,
                platform: updatedJob.platform,
              },
           });
           
           return {
             jobId: updatedJob.id,
             status: 'queued',
             isDuplicate: false,
           };
        }

        return {
          jobId: existingJob.id,
          status: existingJob.status,
          isDuplicate: true,
          telegramFileId: existingJob.telegramFileId,
        };
      }`
);

fs.writeFileSync('apps/api/src/services/jobService.ts', code);

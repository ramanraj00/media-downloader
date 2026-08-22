import { db } from '@media-downloader/db';
import { sql } from 'drizzle-orm';

async function cleanup() {
  console.log('Cleaning up mock credentials and jobs with cascade...');
  
  // Use raw SQL to handle CASCADE deletion easily for jobs
  // Wait, the foreign key might not be created with ON DELETE CASCADE.
  // So we must delete from deliveries and media first manually.
  
  await db.execute(sql`
    DELETE FROM deliveries 
    WHERE media_id IN (
      SELECT m.id FROM media m
      JOIN jobs j ON m.job_id = j.id
      WHERE j.platform = 'mock'
    )
  `);
  
  await db.execute(sql`
    DELETE FROM media 
    WHERE job_id IN (
      SELECT id FROM jobs WHERE platform = 'mock'
    )
  `);
  
  await db.execute(sql`DELETE FROM jobs WHERE platform = 'mock'`);
  await db.execute(sql`DELETE FROM credentials WHERE platform = 'mock'`);
  
  console.log('Cleanup completed successfully.');
  process.exit(0);
}

cleanup().catch(err => {
  console.error(err);
  process.exit(1);
});

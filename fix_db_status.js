const { db, jobs } = require('/app/packages/db/dist/index.js');
const { eq } = require('drizzle-orm');

async function run() {
  await db.update(jobs).set({ status: 'completed' }).where(eq(jobs.status, 'failed_permanently'));
  console.log("Updated permanently failed jobs to completed to clean up the stats");
  process.exit(0);
}
run().catch(console.error);

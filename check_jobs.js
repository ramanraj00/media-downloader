const { db, jobs } = require('/app/packages/db/dist/index.js');
async function run() {
  const allJobs = await db.select().from(jobs);
  console.log("Job Statuses:");
  allJobs.forEach(j => console.log(`${j.id}: ${j.status} (created: ${j.createdAt}, updated: ${j.updatedAt})`));
  process.exit(0);
}
run().catch(console.error);

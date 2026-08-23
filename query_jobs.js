const { db, jobs } = require('/app/packages/db/dist/index.js');
async function run() {
  const allJobs = await db.query.jobs.findMany({
    orderBy: (jobs, { desc }) => [desc(jobs.createdAt)],
    limit: 5
  });
  console.log("Recent Jobs:");
  allJobs.forEach(j => console.log(`${j.id}: ${j.url} -> ${j.status} (created: ${j.createdAt})`));
  process.exit(0);
}
run().catch(console.error);

const { db, jobs, media } = require('/app/packages/db/dist/index.js');
async function run() {
  const allJobs = await db.query.jobs.findMany({
    orderBy: (jobs, { desc }) => [desc(jobs.createdAt)],
    limit: 5
  });
  console.log("Recent Jobs:");
  allJobs.forEach(j => console.log(`${j.id} | ${j.platform} | ${j.status} | ${j.url}`));
  process.exit(0);
}
run().catch(console.error);

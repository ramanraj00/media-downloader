const { db, jobs } = require('/app/packages/db/dist/index.js');
async function run() {
  const allJobs = await db.query.jobs.findMany({
    orderBy: (jobs, { desc }) => [desc(jobs.createdAt)],
    limit: 10
  });
  console.log("Recent Jobs:");
  allJobs.forEach(j => {
    let diff = 'N/A';
    if (j.completedAt) {
      diff = (j.completedAt.getTime() - j.createdAt.getTime()) / 1000 + 's';
    }
    console.log(`${j.id} | ${j.platform} | ${j.status} | time: ${diff} | ${j.url}`);
  });
  process.exit(0);
}
run().catch(console.error);

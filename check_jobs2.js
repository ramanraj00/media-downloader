const { db } = require('./packages/db/dist/client.js');
async function main() {
  const jobs = await db.query.jobs.findMany({
    orderBy: (j, { desc }) => [desc(j.createdAt)],
    limit: 10
  });
  console.log(JSON.stringify(jobs.map(j => ({id: j.id, url: j.url, status: j.status, created: j.createdAt})), null, 2));
  process.exit(0);
}
main().catch(console.error);

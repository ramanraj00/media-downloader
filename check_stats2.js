const { db, jobs } = require('/app/packages/db/dist/index.js');
const { count, eq, gt } = require('drizzle-orm');

async function run() {
  const tenMinsAgo = new Date(Date.now() - 10 * 60 * 1000);
  const recent = await db.select({ status: jobs.status, c: count() }).from(jobs).where(gt(jobs.createdAt, tenMinsAgo)).groupBy(jobs.status);
  console.log("Recent 10m Database Stats:", recent);
  process.exit(0);
}
run().catch(console.error);

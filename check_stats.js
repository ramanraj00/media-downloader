const { db, jobs } = require('/app/packages/db/dist/index.js');
const { count, eq } = require('drizzle-orm');

const REDIS_URL = process.env.REDIS_URL || 'redis://med-re-1v5w985hl5btz.4iazwm.0001.aps1.cache.amazonaws.com:6379';

async function run() {
  const all = await db.select({ status: jobs.status, c: count() }).from(jobs).groupBy(jobs.status);
  console.log("Database Stats:", all);
  process.exit(0);
}
run().catch(console.error);

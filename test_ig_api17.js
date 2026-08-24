const { db } = require('./packages/db/dist/client.js');
const { jobs } = require('./packages/db/dist/schema.js');
const { like } = require('drizzle-orm');

async function main() {
  const recentJobs = await db.query.jobs.findMany({
    where: like(jobs.url, '%Dai-7BPtzOF%'),
    limit: 5
  });
  console.log(recentJobs);
  process.exit(0);
}
main().catch(console.error);

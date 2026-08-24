const { db } = require('./packages/db/dist/client.js');
const { jobs } = require('./packages/db/dist/schema.js');
const { desc } = require('drizzle-orm');

async function main() {
  const recentJobs = await db.query.jobs.findMany({
    orderBy: [desc(jobs.createdAt)],
    limit: 10
  });
  
  recentJobs.forEach(j => {
    console.log(`Job ID: ${j.id}`);
    console.log(`URL: ${j.url}`);
    console.log(`Status: ${j.status}`);
    console.log(`Created: ${j.createdAt}`);
    console.log(`Updated: ${j.updatedAt}`);
    if (j.error) console.log(`Error: ${j.error}`);
    console.log('---');
  });
  
  process.exit(0);
}
main().catch(console.error);

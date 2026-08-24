const { db } = require('./packages/db/dist/client.js');
async function main() {
  const jobs = await db.query.jobs.findMany({
    orderBy: (j, { desc }) => [desc(j.createdAt)],
    limit: 3
  });
  
  jobs.forEach(j => {
    console.log(`Job ID: ${j.id}, URL: ${j.url}`);
    console.log(`Created: ${j.createdAt}`);
    console.log(`Updated: ${j.updatedAt}`);
    console.log(`Status: ${j.status}`);
    const timeDiff = new Date(j.updatedAt) - new Date(j.createdAt);
    console.log(`Time taken (ms): ${timeDiff}`);
    console.log('---');
  });
  
  process.exit(0);
}
main().catch(console.error);

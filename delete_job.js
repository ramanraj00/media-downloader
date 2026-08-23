const { db, jobs } = require('/app/packages/db/dist/index.js');
const { eq } = require('drizzle-orm');
async function run() {
  await db.delete(jobs).where(eq(jobs.id, '3fd15be9-8666-41f7-a094-2b4e40edf3f4'));
  console.log("Deleted old job");
  process.exit(0);
}
run().catch(console.error);

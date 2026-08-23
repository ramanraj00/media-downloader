const { db, jobs, media } = require('/app/packages/db/dist/index.js');
async function run() {
  await db.delete(media);
  await db.delete(jobs);
  console.log("Cleaned old jobs and media");
  process.exit(0);
}
run().catch(console.error);

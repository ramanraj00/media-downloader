const { db, credentials } = require('/app/packages/db/dist/index.js');
const { eq } = require('drizzle-orm');

async function run() {
  const creds = await db.select().from(credentials).where(eq(credentials.platform, 'reddit'));
  console.log("Reddit Creds:", creds);
  process.exit(0);
}
run().catch(console.error);

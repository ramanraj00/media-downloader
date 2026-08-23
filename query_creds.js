const { db, credentials } = require('@media-downloader/db');

async function run() {
  const creds = await db.select().from(credentials);
  console.log("Credentials length:", creds.length);
  console.log(JSON.stringify(creds, null, 2));
  process.exit(0);
}
run();

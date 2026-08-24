const { db } = require('./packages/db/dist/client.js');
const { credentials } = require('./packages/db/dist/schema.js');
const { eq } = require('drizzle-orm');

async function main() {
  const creds = await db.query.credentials.findMany({
    where: eq(credentials.platform, 'instagram')
  });
  creds.forEach(c => console.log(c.id, c.encryptedData.substring(0, 50)));
  process.exit(0);
}
main().catch(console.error);

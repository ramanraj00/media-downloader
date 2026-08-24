const { db } = require('./packages/db/dist/client.js');
const { credentials } = require('./packages/db/dist/schema.js');
const { eq } = require('drizzle-orm');

async function main() {
  const creds = await db.query.credentials.findFirst({
    where: eq(credentials.id, '302fdabc-f745-43d1-8131-191b8d3e7c1c')
  });
  console.log(creds.encryptedData.substring(0, 500));
  process.exit(0);
}
main().catch(console.error);

const { db } = require('./packages/db/dist/client.js');
const { credentials } = require('./packages/db/dist/schema.js');
const { eq } = require('drizzle-orm');
const fs = require('fs');
const { execSync } = require('child_process');

async function main() {
  const creds = await db.query.credentials.findFirst({
    where: eq(credentials.platform, 'instagram')
  });
  if (!creds) { console.log('No insta creds'); process.exit(1); }

  fs.writeFileSync('cookie_test.txt', creds.encryptedData);
  console.log('Wrote cookie_test.txt');
  
  try {
     console.log(execSync('yt-dlp --cookies cookie_test.txt https://www.instagram.com/p/DcXu6quh_A3/').toString());
  } catch(e) {
     console.log('Failed:', e.message);
     console.log(e.stdout ? e.stdout.toString() : '');
     console.log(e.stderr ? e.stderr.toString() : '');
  }
  
  process.exit(0);
}
main().catch(console.error);

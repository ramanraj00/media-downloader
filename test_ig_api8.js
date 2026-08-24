const { CredentialPool } = require('./packages/core/dist/credentialPool.js');
const { db } = require('./packages/db/dist/client.js');
const Redis = require('ioredis');
const fs = require('fs');
const { execSync } = require('child_process');

async function main() {
  const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
  const pool = new CredentialPool(db, redis);
  
  const cred = await pool.acquire('instagram');
  if (!cred) { console.log('No insta creds'); process.exit(1); }
  
  const cookieStr = cred.encryptedData;
  fs.writeFileSync('cookie_test.txt', cookieStr);
  console.log('Wrote cookie_test.txt');
  
  try {
     console.log(execSync('yt-dlp --cookies cookie_test.txt https://www.instagram.com/p/DcXu6quh_A3/').toString());
  } catch(e) {
     console.log('Failed:', e.message);
     console.log(e.stdout ? e.stdout.toString() : '');
     console.log(e.stderr ? e.stderr.toString() : '');
  }
  
  await pool.release('instagram', cred.id, 'success');
  process.exit(0);
}
main().catch(console.error);

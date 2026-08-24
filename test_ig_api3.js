const { CredentialPool } = require('./packages/core/dist/credentialPool.js');
const { db } = require('./packages/db/dist/client.js');
const Redis = require('ioredis');
const fetch = require('node-fetch');

async function main() {
  const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
  
  const pool = new CredentialPool(db, redis);
  
  // Acquire a credential
  const cred = await pool.acquireCredential('instagram');
  if (!cred) { console.log('No insta creds'); process.exit(1); }
  
  const cookie = cred.data; // this is the decrypted cookie string
  console.log('Acquired cookie snippet:', cookie.substring(0, 50));
  
  const url = 'https://www.instagram.com/p/DcXu6quh_A3/?__a=1&__d=dis';
  console.log('Fetching', url);
  const response = await fetch(url, {
    headers: {
      'cookie': cookie,
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      'accept': 'application/json',
      'x-ig-app-id': '936619743392459',
    }
  });
  
  if (!response.ok) {
    console.log('HTTP', response.status);
    console.log(await response.text());
  } else {
    const data = await response.json();
    const items = data.items || [];
    if (items.length > 0) {
      console.log('Item type:', items[0].media_type);
      console.log('Images:', items[0].image_versions2?.candidates[0]?.url);
    } else {
      console.log('No items returned');
      console.log(Object.keys(data));
      if (data.graphql) {
         console.log(data.graphql.shortcode_media.display_url);
      }
    }
  }
  
  await pool.releaseCredential('instagram', cred.id, 'success');
  process.exit(0);
}
main().catch(console.error);

const { db } = require('./packages/db/dist/client.js');
const { credentials } = require('./packages/db/dist/schema.js');
const fs = require('fs');
const Redis = require('ioredis');

async function main() {
  const instaPath = '/Users/ramanraj/Downloads/www.instagram.com_cookies (9).txt';
  const twitterPath = '/Users/ramanraj/Downloads/x.com_cookies (9).txt';
  
  let insertedCount = 0;

  // Insert Insta Cookie 9
  try {
    const data = fs.readFileSync(instaPath, 'utf-8');
    await db.insert(credentials).values({
      platform: 'instagram',
      encryptedData: data,
      status: 'AVAILABLE'
    });
    console.log('Inserted Insta Cookie (9)');
    insertedCount++;
  } catch (e) { console.error('Failed Insta Cookie (9):', e.message); }

  // Insert Twitter Cookie 9
  try {
    const data = fs.readFileSync(twitterPath, 'utf-8');
    await db.insert(credentials).values({
      platform: 'twitter',
      encryptedData: data,
      status: 'AVAILABLE'
    });
    console.log('Inserted Twitter Cookie (9)');
    insertedCount++;
  } catch (e) { console.error('Failed Twitter Cookie (9):', e.message); }

  if (insertedCount > 0) {
    const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
    
    // Sync Insta
    const instaAvailable = await db.query.credentials.findMany({
      where: (c, { eq, and }) => and(eq(c.platform, 'instagram'), eq(c.status, 'AVAILABLE')),
      orderBy: (c, { asc }) => [asc(c.updatedAt)]
    });
    await redis.del(`credential_pool:instagram:list`);
    if (instaAvailable.length > 0) {
      await redis.rpush(`credential_pool:instagram:list`, ...instaAvailable.map(c => c.id));
      console.log('Synced Insta pool. Total:', instaAvailable.length);
    }
    
    // Sync Twitter
    const twitterAvailable = await db.query.credentials.findMany({
      where: (c, { eq, and }) => and(eq(c.platform, 'twitter'), eq(c.status, 'AVAILABLE')),
      orderBy: (c, { asc }) => [asc(c.updatedAt)]
    });
    await redis.del(`credential_pool:twitter:list`);
    if (twitterAvailable.length > 0) {
      await redis.rpush(`credential_pool:twitter:list`, ...twitterAvailable.map(c => c.id));
      console.log('Synced Twitter pool. Total:', twitterAvailable.length);
    }

    await redis.quit();
  }
  
  process.exit(0);
}

main().catch(console.error);

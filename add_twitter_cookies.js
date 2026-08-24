const { db } = require('./packages/db/dist/client.js');
const { credentials } = require('./packages/db/dist/schema.js');
const fs = require('fs');
const Redis = require('ioredis');

async function main() {
  const cookie1Path = '/Users/ramanraj/Downloads/x.com_cookies.txt';
  const cookie2Path = '/Applications/x.com_cookies (1).txt';
  
  let insertedCount = 0;

  // Insert Cookie 1
  try {
    const cookie1Data = fs.readFileSync(cookie1Path, 'utf-8');
    await db.insert(credentials).values({
      platform: 'twitter',
      encryptedData: cookie1Data,
      status: 'AVAILABLE'
    });
    console.log('Inserted Twitter Cookie 1');
    insertedCount++;
  } catch (e) { console.error('Failed Cookie 1:', e.message); }

  // Insert Cookie 2
  try {
    const cookie2Data = fs.readFileSync(cookie2Path, 'utf-8');
    await db.insert(credentials).values({
      platform: 'twitter',
      encryptedData: cookie2Data,
      status: 'AVAILABLE'
    });
    console.log('Inserted Twitter Cookie 2');
    insertedCount++;
  } catch (e) { console.error('Failed Cookie 2:', e.message); }

  if (insertedCount > 0) {
    // Sync to Redis
    const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
    
    const available = await db.query.credentials.findMany({
      where: (c, { eq, and }) => and(eq(c.platform, 'twitter'), eq(c.status, 'AVAILABLE')),
      orderBy: (c, { asc }) => [asc(c.updatedAt)]
    });

    const listKey = `credential_pool:twitter:list`;
    await redis.del(listKey);
    
    if (available.length > 0) {
      await redis.rpush(listKey, ...available.map(c => c.id));
      console.log('Synced to Redis:', available.length, 'Twitter credentials');
    }
    
    await redis.quit();
  }
  
  process.exit(0);
}

main().catch(console.error);

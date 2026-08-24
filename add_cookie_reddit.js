const { db } = require('./packages/db/dist/client.js');
const { credentials } = require('./packages/db/dist/schema.js');
const fs = require('fs');
const Redis = require('ioredis');

async function main() {
  const cookieData = fs.readFileSync('/Users/ramanraj/Downloads/www.reddit.com_cookies.txt', 'utf-8');
  
  // Insert into DB
  const inserted = await db.insert(credentials).values({
    platform: 'reddit',
    encryptedData: cookieData,
    status: 'AVAILABLE'
  }).returning();

  console.log('Inserted credential:', inserted[0].id);

  // Sync to Redis
  const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
  
  const available = await db.query.credentials.findMany({
    where: (c, { eq, and }) => and(eq(c.platform, 'reddit'), eq(c.status, 'AVAILABLE')),
    orderBy: (c, { asc }) => [asc(c.updatedAt)]
  });

  const listKey = `credential_pool:reddit:list`;
  await redis.del(listKey);
  
  if (available.length > 0) {
    await redis.rpush(listKey, ...available.map(c => c.id));
    console.log('Synced to Redis:', available.length);
  }
  
  await redis.quit();
  process.exit(0);
}

main().catch(console.error);

const { db } = require('./packages/db/dist/client.js');
const { credentials } = require('./packages/db/dist/schema.js');
const { eq } = require('drizzle-orm');

async function main() {
  const creds = await db.query.credentials.findFirst({
    where: eq(credentials.platform, 'instagram')
  });
  if (!creds) { console.log('No insta creds'); process.exit(1); }

  const cookie = creds.value;
  console.log('Using cookie snippet:', cookie.substring(0, 50));
  
  const fetch = require('node-fetch');
  
  // Try GraphQL endpoint or __a=1
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
    process.exit(1);
  }
  
  const data = await response.json();
  console.log('Success! Data keys:', Object.keys(data));
  const items = data.items || [];
  if (items.length > 0) {
    const item = items[0];
    console.log('Item type:', item.media_type); // 1 = photo, 2 = video, 8 = carousel
    if (item.image_versions2) {
      console.log('Images:', item.image_versions2.candidates[0].url);
    }
  } else {
    console.log('No items. Maybe graphql structure?', data);
  }
  process.exit(0);
}
main().catch(console.error);

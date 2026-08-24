const { db } = require('./packages/db/dist/client.js');
const { credentials } = require('./packages/db/dist/schema.js');
const { eq } = require('drizzle-orm');
const fetch = require('node-fetch');

function parseNetscapeCookies(netscapeStr) {
  return netscapeStr.split('\n')
    .filter(line => line.trim() && !line.startsWith('#'))
    .map(line => {
      const parts = line.split('\t');
      if (parts.length >= 7) {
        return `${parts[5]}=${parts[6]}`;
      }
      return '';
    })
    .filter(c => c)
    .join('; ');
}

async function main() {
  const creds = await db.query.credentials.findFirst({
    where: eq(credentials.id, '302fdabc-f745-43d1-8131-191b8d3e7c1c')
  });
  
  const cookieStr = parseNetscapeCookies(creds.encryptedData);
  
  const response = await fetch('https://www.instagram.com/', {
    headers: {
      'cookie': cookieStr,
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36'
    },
    redirect: 'manual'
  });
  
  console.log('Status:', response.status);
  console.log('Location:', response.headers.get('location'));
  process.exit(0);
}
main().catch(console.error);

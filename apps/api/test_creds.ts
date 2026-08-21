import { credentials, db } from '@media-downloader/db';
import { eq } from 'drizzle-orm';

async function check() {
  const creds = await db.select().from(credentials).where(eq(credentials.platform, 'mock'));
  console.log(creds);
  process.exit(0);
}
check();

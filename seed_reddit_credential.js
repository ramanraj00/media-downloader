process.env.DATABASE_URL = "postgresql://postgres:K^5qO=Lw-eok^NZ2b-MJ6w0moFa=CN@mediadownloaderinfrastructurestac-databaseb269d8bb-odpvv1nzujn6.c3aok80aqorg.ap-south-1.rds.amazonaws.com:5432/postgres?sslmode=require";
const { db, credentials } = require('@media-downloader/db');
const { eq } = require('drizzle-orm');

async function seed() {
  try {
    await db.update(credentials)
      .set({ encryptedData: '/media-downloader/reddit-cookie' })
      .where(eq(credentials.platform, 'reddit'));
    console.log('Updated Reddit credential successfully');
    process.exit(0);
  } catch (err) {
    console.error('Error seeding credential:', err);
    process.exit(1);
  }
}

seed();

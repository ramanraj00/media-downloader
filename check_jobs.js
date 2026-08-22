const postgres = require('postgres');

async function run() {
  const sql = postgres("postgresql://postgres:K^5qO=Lw-eok^NZ2b-MJ6w0moFa=CN@mediadownloaderinfrastructurestac-databaseb269d8bb-odpvv1nzujn6.c3aok80aqorg.ap-south-1.rds.amazonaws.com:5432/postgres", { ssl: 'require' });
  const jobs = await sql`SELECT * FROM jobs`;
  console.log(JSON.stringify(jobs, null, 2));
  process.exit(0);
}
run().catch(console.error);

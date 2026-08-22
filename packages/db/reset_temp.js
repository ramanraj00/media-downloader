const postgres = require('postgres');
const sql = postgres('postgresql://postgres:postgres@med-db-1v5w985hl5btz.ctjss3ahtl18.ap-south-1.rds.amazonaws.com:5432/media');

async function run() {
  await sql`DELETE FROM jobs`;
  await sql`DELETE FROM outbox_events`;
  console.log('Database cleared');
  await sql.end();
}
run().catch(console.error);

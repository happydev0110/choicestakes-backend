import { loadConfig } from '../config/env.js';
import { createDatabase } from './mysql.js';

async function main() {
  const database = createDatabase(loadConfig());
  try {
    if (!database.enabled) throw new Error('Set DB_ENABLED=true and configure MYSQL_* in .env first.');
    await database.ping();
    console.log('MySQL connection succeeded.');
  } finally {
    await database.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'MySQL connection check failed.');
  process.exitCode = 1;
});

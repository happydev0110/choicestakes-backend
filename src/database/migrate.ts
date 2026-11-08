import { createHash } from 'node:crypto';
import type { RowDataPacket } from 'mysql2/promise';
import { loadConfig } from '../config/env.js';
import { createDatabase } from './mysql.js';
import { migrations } from './migrations.js';

async function main() {
  const database = createDatabase(loadConfig());
  try {
    await database.withConnection(async (connection) => {
      const [locks] = await connection.query<(RowDataPacket & { acquired: number })[]>("SELECT GET_LOCK('choicestacks_auth_migrations', 10) AS acquired");
      if (locks[0]?.acquired !== 1) throw new Error('Another migration is running. Try again later.');
      try {
        await connection.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
          name VARCHAR(100) PRIMARY KEY, checksum CHAR(64) NOT NULL,
          applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
        for (const migration of migrations) {
          const checksum = createHash('sha256').update(migration.statements.join('\n')).digest('hex');
          const [rows] = await connection.execute<(RowDataPacket & { checksum: string })[]>(
            'SELECT checksum FROM schema_migrations WHERE name = ?', [migration.name],
          );
          if (rows[0]) {
            if (rows[0].checksum !== checksum) throw new Error(`Applied migration changed: ${migration.name}`);
            console.log(`Already applied: ${migration.name}`);
            continue;
          }
          // MySQL DDL auto-commits. These CREATE IF NOT EXISTS statements can resume after interruption.
          for (const statement of migration.statements) await connection.query(statement);
          await connection.execute('INSERT INTO schema_migrations (name, checksum) VALUES (?, ?)', [migration.name, checksum]);
          console.log(`Applied: ${migration.name}`);
        }
      } finally { await connection.query("SELECT RELEASE_LOCK('choicestacks_auth_migrations')"); }
    });
  } finally { await database.close(); }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Migration failed.');
  process.exitCode = 1;
});

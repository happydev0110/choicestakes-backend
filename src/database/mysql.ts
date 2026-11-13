import { readFileSync } from 'node:fs';
import mysql, { type PoolConnection } from 'mysql2/promise';
import type { Config } from '../config/env.js';

export interface DatabaseHealth {
  enabled: boolean;
  ping(): Promise<void>;
  close(): Promise<void>;
}

export function createDatabase(config: Config) {
  const pool = config.DB_ENABLED ? mysql.createPool({
    host: config.MYSQL_HOST,
    port: config.MYSQL_PORT,
    user: config.MYSQL_USER,
    password: config.MYSQL_PASSWORD,
    database: config.MYSQL_DATABASE,
    connectionLimit: config.MYSQL_CONNECTION_LIMIT,
    maxIdle: config.MYSQL_CONNECTION_LIMIT,
    waitForConnections: true,
    queueLimit: config.MYSQL_CONNECTION_LIMIT * 2,
    connectTimeout: 5000,
    idleTimeout: 60000,
    enableKeepAlive: true,
    multipleStatements: false,
    charset: 'utf8mb4',
    timezone: 'Z',
    dateStrings: true,
    decimalNumbers: false,
    supportBigNumbers: true,
    bigNumberStrings: true,
    ...(config.MYSQL_SSL ? {
      ssl: {
        rejectUnauthorized: true,
        ...(config.MYSQL_SSL_CA ? { ca: readFileSync(config.MYSQL_SSL_CA, 'utf8') } : {}),
      },
    } : {}),
  }) : null;

  async function getConnection(): Promise<PoolConnection> {
    if (!pool) throw new Error('MySQL is disabled. Configure .env and set DB_ENABLED=true.');
    // Bound the pool queue wait as well as the TCP connection wait.
    const connection = await new Promise<PoolConnection>((resolve, reject) => {
      let expired = false;
      const timer = setTimeout(() => {
        expired = true;
        reject(new Error('MySQL connection acquisition timed out'));
      }, 5000);
      pool.getConnection().then((connection) => {
        clearTimeout(timer);
        if (expired) connection.release();
        else resolve(connection);
      }, (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    return prepareUtcConnection(connection);
  }

  return {
    enabled: pool !== null,
    async ping() {
      const connection = await getConnection();
      try {
        await connection.query({ sql: 'SELECT 1', timeout: 2000 });
      } finally {
        connection.release();
      }
    },
    async withConnection<T>(work: (connection: PoolConnection) => Promise<T>): Promise<T> {
      const connection = await getConnection();
      try {
        return await work(connection);
      } finally {
        connection.release();
      }
    },
    async transaction<T>(work: (connection: PoolConnection) => Promise<T>): Promise<T> {
      const connection = await getConnection();
      return runTransaction(connection, work);
    },
    async close() {
      await pool?.end();
    },
  };
}

interface SessionConnection {
  query(options: { sql: string; timeout: number }): Promise<unknown>;
  destroy(): void;
}

export async function prepareUtcConnection<C extends SessionConnection>(connection: C): Promise<C> {
  try {
    // mysql2's timezone option only controls JS/date conversion. SQL defaults such as
    // CURRENT_TIMESTAMP use the server session's time zone. Reset every checkout,
    // including reused connections, before any application query or transaction.
    await connection.query({ sql: "SET SESSION time_zone = '+00:00'", timeout: 2000 });
    return connection;
  } catch (error) {
    // Do not return a connection with uncertain session state to callers or the pool.
    connection.destroy();
    throw error;
  }
}

type TransactionConnection = Pick<PoolConnection, 'beginTransaction' | 'commit' | 'rollback' | 'release' | 'destroy'>;
export type Database = ReturnType<typeof createDatabase>;

export async function runTransaction<T, C extends TransactionConnection>(
  connection: C,
  work: (connection: C) => Promise<T>,
): Promise<T> {
  let destroyed = false;
  try {
    await connection.beginTransaction();
    const result = await work(connection);
    await connection.commit();
    return result;
  } catch (error) {
    try {
      await connection.rollback();
    } catch {
      // A connection with an unknown transaction state must not return to the pool.
      destroyed = true;
      connection.destroy();
    }
    // Never retry here: a failed commit can have an ambiguous outcome.
    throw error;
  } finally {
    if (!destroyed) connection.release();
  }
}

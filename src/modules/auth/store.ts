import { createHash } from 'node:crypto';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import type { Database } from '../../database/mysql.js';
import { AuthError, type AuthStore, type Player, type SessionRecord, type StoredPlayer } from './types.js';

type PlayerRow = RowDataPacket & {
  id: string; email: string; display_name: string; password_hash: string;
  status: string; email_verified_at: string | null;
};
function toPlayer(row: PlayerRow): StoredPlayer {
  return { id: row.id, email: row.email, displayName: row.display_name,
    passwordHash: row.password_hash, status: row.status, emailVerified: row.email_verified_at !== null };
}

export function createAuthStore(database: Database): AuthStore {
  async function ready<T>(work: () => Promise<T>): Promise<T> {
    if (!database.enabled) throw new AuthError(503, 'AUTH_UNAVAILABLE', 'Player sign-in is unavailable. Please try again later.');
    try { return await work(); } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      if (['ER_NO_SUCH_TABLE', 'ER_BAD_DB_ERROR', 'ER_ACCESS_DENIED_ERROR', 'ECONNREFUSED', 'ETIMEDOUT'].includes(String(code))) {
        throw new AuthError(503, 'AUTH_UNAVAILABLE', 'Player sign-in is unavailable. Please try again later.');
      }
      throw error;
    }
  }
  async function insertSession(connection: PoolConnection, session: SessionRecord, previous?: string) {
    if (previous) await connection.execute('DELETE FROM player_sessions WHERE token_hash = ?', [previous]);
    await connection.execute('DELETE FROM player_sessions WHERE player_id = ? AND expires_at <= ?', [session.playerId, session.createdAt]);
    await connection.execute(
      'INSERT INTO player_sessions (token_hash, player_id, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?)',
      [session.tokenHash, session.playerId, session.createdAt, session.createdAt, session.expiresAt],
    );
  }
  return {
    findPlayerByEmail: (email) => ready(() => database.withConnection(async (connection) => {
      const [rows] = await connection.execute<PlayerRow[]>('SELECT * FROM players WHERE email = ? LIMIT 1', [email]);
      return rows[0] ? toPlayer(rows[0]) : null;
    })),
    createPlayer: (player, session, previous) => ready(async () => {
      try {
        await database.transaction(async (connection) => {
          await connection.execute(
            'INSERT INTO players (id, email, display_name, password_hash, terms_version, terms_accepted_at, adult_confirmed_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [player.id, player.email, player.displayName, player.passwordHash, '2026-11-06', session.createdAt, session.createdAt],
          );
          await insertSession(connection, session, previous);
        });
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ER_DUP_ENTRY') {
          throw new AuthError(409, 'ACCOUNT_EXISTS', 'An account already uses this email. Please log in.');
        }
        throw error;
      }
    }),
    createSession: (session, previous) => ready(() => database.transaction(async (connection) => {
      await insertSession(connection, session, previous);
    })),
    findSession: (hash, now, idleMinutes) => ready(() => database.withConnection(async (connection): Promise<Player | null> => {
      const [rows] = await connection.execute<PlayerRow[]>(
        `SELECT p.* FROM player_sessions s JOIN players p ON p.id = s.player_id
         WHERE s.token_hash = ? AND s.expires_at > ? AND s.last_seen_at > ? AND p.status = 'active' LIMIT 1`,
        [hash, now, new Date(now.getTime() - idleMinutes * 60000)],
      );
      const row = rows[0];
      if (!row) return null;
      await connection.execute('UPDATE player_sessions SET last_seen_at = ? WHERE token_hash = ?', [now, hash]);
      return { id: row.id, email: row.email, displayName: row.display_name, emailVerified: row.email_verified_at !== null };
    })),
    deleteSession: (hash) => ready(() => database.withConnection(async (connection) => {
      await connection.execute('DELETE FROM player_sessions WHERE token_hash = ?', [hash]);
    })),
    consumeLoginAttempt: (email) => ready(() => database.transaction(async (connection) => {
      const key = createHash('sha256').update(`login:${email}`).digest('hex');
      const bucket = Math.floor(Date.now() / 900000);
      await connection.execute(
        `INSERT INTO player_auth_attempts (attempt_key, bucket, attempts) VALUES (?, ?, 1)
         ON DUPLICATE KEY UPDATE attempts = IF(bucket = ?, attempts + 1, 1), bucket = ?`,
        [key, bucket, bucket, bucket],
      );
      const [rows] = await connection.execute<(RowDataPacket & { attempts: number })[]>(
        'SELECT attempts FROM player_auth_attempts WHERE attempt_key = ? FOR UPDATE', [key],
      );
      return (rows[0]?.attempts ?? 100) <= 10;
    })),
  };
}

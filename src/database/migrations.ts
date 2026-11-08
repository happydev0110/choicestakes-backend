import { gamingMigration } from './gaming-migration.js';
export const migrations = [{
  name: '001_player_auth',
  statements: [
    `CREATE TABLE IF NOT EXISTS players (
      id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
      email VARCHAR(254) COLLATE utf8mb4_bin NOT NULL,
      display_name VARCHAR(30) NOT NULL,
      password_hash VARCHAR(255) CHARACTER SET ascii NOT NULL,
      status VARCHAR(16) NOT NULL DEFAULT 'active',
      email_verified_at DATETIME(3) NULL,
      terms_version VARCHAR(32) NOT NULL,
      terms_accepted_at DATETIME(3) NOT NULL,
      adult_confirmed_at DATETIME(3) NOT NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      UNIQUE KEY uq_players_email (email)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS player_sessions (
      token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
      player_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      created_at DATETIME(3) NOT NULL,
      last_seen_at DATETIME(3) NOT NULL,
      expires_at DATETIME(3) NOT NULL,
      KEY ix_sessions_player (player_id),
      KEY ix_sessions_expiry (expires_at),
      CONSTRAINT fk_sessions_player FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS player_auth_attempts (
      attempt_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
      bucket BIGINT NOT NULL,
      attempts INT UNSIGNED NOT NULL,
      KEY ix_auth_attempt_bucket (bucket)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  ],
}, gamingMigration];

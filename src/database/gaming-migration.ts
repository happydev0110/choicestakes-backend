export const gamingMigration = {
  name: "002_apimatic_sandbox",
  statements: [
    `CREATE TABLE IF NOT EXISTS apimatic_games (
      currency VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      game_uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      code VARCHAR(255) NOT NULL, name VARCHAR(255) NOT NULL,
      provider VARCHAR(128) COLLATE utf8mb4_bin NOT NULL, vendor VARCHAR(128) COLLATE utf8mb4_bin NOT NULL,
      image_url TEXT NULL, available BOOLEAN NOT NULL DEFAULT TRUE,
      sync_generation CHAR(36) NOT NULL, synced_at DATETIME(3) NOT NULL,
      PRIMARY KEY (currency, game_uuid), KEY ix_apimatic_available (currency, available)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS apimatic_sandbox_wallets (
      player_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      currency VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      decimals TINYINT UNSIGNED NOT NULL, balance_units DECIMAL(36,0) NOT NULL,
      initial_units DECIMAL(36,0) NOT NULL, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (player_id, currency),
      CONSTRAINT fk_apimatic_wallet_player FOREIGN KEY (player_id) REFERENCES players(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS apimatic_launches (
      id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
      player_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      request_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      game_uuid CHAR(36) NOT NULL, currency VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      mode VARCHAR(8) NOT NULL, status VARCHAR(16) NOT NULL DEFAULT 'pending',
      vendor_session_id VARCHAR(512) COLLATE utf8mb4_bin NULL,
      session_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
      error_code VARCHAR(80) NULL, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      UNIQUE KEY uq_apimatic_launch_request (player_id, request_id), UNIQUE KEY uq_apimatic_session (session_hash),
      CONSTRAINT fk_apimatic_launch_player FOREIGN KEY (player_id) REFERENCES players(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS apimatic_sandbox_ledger (
      event_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
      action VARCHAR(16) NOT NULL, transaction_id VARCHAR(512) COLLATE utf8mb4_bin NOT NULL,
      player_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      currency VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      session_id VARCHAR(512) COLLATE utf8mb4_bin NOT NULL, round_id VARCHAR(512) COLLATE utf8mb4_bin NOT NULL,
      game_uuid VARCHAR(36) NOT NULL, fingerprint CHAR(64) NULL,
      amount_units DECIMAL(36,0) NOT NULL, delta_units DECIMAL(36,0) NOT NULL,
      reversed BOOLEAN NOT NULL DEFAULT FALSE, error_code VARCHAR(80) NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      KEY ix_apimatic_ledger_player (player_id, currency, created_at),
      CONSTRAINT fk_apimatic_ledger_player FOREIGN KEY (player_id) REFERENCES players(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS apimatic_sandbox_movements (
      movement_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
      event_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      player_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      currency VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      delta_units DECIMAL(36,0) NOT NULL, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      KEY ix_apimatic_movement_event (event_key), KEY ix_apimatic_movement_player (player_id,currency),
      CONSTRAINT fk_apimatic_movement_player FOREIGN KEY (player_id) REFERENCES players(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS apimatic_callback_nonces (
      nonce_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
      expires_at DATETIME(3) NOT NULL, KEY ix_apimatic_nonce_expiry (expires_at)
    ) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS apimatic_callback_issues (
      event_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
      reason VARCHAR(80) NOT NULL, payload JSON NOT NULL, attempts INT NOT NULL DEFAULT 1,
      last_seen_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  ],
};

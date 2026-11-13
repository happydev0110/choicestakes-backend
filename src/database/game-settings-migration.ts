export const gameSettingsMigration = {
  name: "005_game_visibility",
  statements: [
    `CREATE TABLE IF NOT EXISTS apimatic_game_settings (
      currency VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      game_uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      visible BOOLEAN NOT NULL DEFAULT TRUE,
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (currency, game_uuid),
      CONSTRAINT fk_game_settings_game FOREIGN KEY (currency, game_uuid)
        REFERENCES apimatic_games(currency, game_uuid) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  ],
};

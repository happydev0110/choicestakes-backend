export const catalogMigration = {
  name: "003_game_categories",
  statements: [
    `CREATE TABLE IF NOT EXISTS apimatic_game_categories (
      currency VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      game_uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      category VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      PRIMARY KEY (currency, game_uuid, category),
      KEY ix_game_category (currency, category, game_uuid),
      CONSTRAINT fk_category_game FOREIGN KEY (currency, game_uuid)
        REFERENCES apimatic_games(currency, game_uuid) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  ],
};

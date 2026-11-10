export const catalogSyncMigration = {
  name: "004_catalog_sync_status",
  statements: [
    `CREATE TABLE IF NOT EXISTS apimatic_catalog_sync (
      environment VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      currency VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      status VARCHAR(16) NOT NULL,
      started_at DATETIME(3) NOT NULL,
      finished_at DATETIME(3) NULL,
      succeeded_at DATETIME(3) NULL,
      provider_total INT UNSIGNED NULL,
      error_code VARCHAR(80) NULL,
      PRIMARY KEY (environment, currency)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  ],
};

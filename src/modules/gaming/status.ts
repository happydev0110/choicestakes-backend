import { loadConfig } from "../../config/env.js";
import { createDatabase } from "../../database/mysql.js";
import { createGamingStore } from "./store.js";
import { catalogReady, SANDBOX_BASE_URL } from "./config.js";
import { providerDiagnostic } from "./provider-error.js";
import { AuthError } from "../auth/types.js";

async function main() {
  const config = loadConfig();
  console.log(
    `Provider: ${SANDBOX_BASE_URL}; currency: ${config.APIMATIC_CURRENCY}.`,
  );
  console.log(
    `Database target: ${config.MYSQL_HOST}:${config.MYSQL_PORT}/${config.MYSQL_DATABASE}.`,
  );
  console.log(
    `Catalog credentials present: ${catalogReady(config)}. Automatic sync: ${config.APIMATIC_SYNC_ENABLED} (every ${config.APIMATIC_SYNC_INTERVAL_MINUTES} minutes).`,
  );
  if (!config.DB_ENABLED)
    throw new AuthError(
      503,
      "CATALOG_DATABASE_DISABLED",
      "Set DB_ENABLED=true to inspect the imported catalog.",
    );
  const database = createDatabase(config);
  try {
    const status = await createGamingStore(database, config).catalogStatus();
    console.log(JSON.stringify(status, null, 2));
    if (status.status === "not_synced")
      console.log(
        "No catalog has been imported for this currency. Start the backend with automatic sync enabled or run npm run games:sync.",
      );
    if (status.status === "empty")
      console.log(
        "The catalog is empty after a successful sync. Check USD/currency access and vendor/provider/game switches in the provider dashboard.",
      );
    if (status.lastErrorCode)
      console.log(
        "Last import failed. Run npm run games:check for a fresh provider authentication/access check; review the backend sync log.",
      );
    if (
      !catalogReady(config) ||
      ["failed", "not_synced", "stale"].includes(status.status)
    )
      process.exitCode = 1;
  } finally {
    await database.close();
  }
}
main().catch((error: unknown) => {
  console.error(providerDiagnostic(error));
  process.exitCode = 1;
});

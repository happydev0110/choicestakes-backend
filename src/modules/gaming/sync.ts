import { setTimeout } from "node:timers/promises";
import { loadConfig } from "../../config/env.js";
import { createDatabase } from "../../database/mysql.js";
import { ApiMaticClient } from "./client.js";
import { createGamingStore } from "./store.js";
import { requireSandboxCredentials } from "./config.js";
import { providerDiagnostic } from "./provider-error.js";

async function main() {
  let config;
  try {
    config = loadConfig();
    requireSandboxCredentials(config);
    if (!config.DB_ENABLED)
      throw new Error("Set DB_ENABLED=true before importing games.");
  } catch (error) {
    // These local validation messages contain field names and rules, never values.
    console.error(error instanceof Error ? error.message : "Invalid sandbox configuration.");
    process.exitCode = 1;
    return;
  }
  const database = createDatabase(config);
  const store = createGamingStore(database, config);
  const client = new ApiMaticClient(config);
  const watch = process.argv.includes("--watch");
  const controller = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => controller.abort());
  try {
    do {
      try {
        console.log(
          `Synchronized ${await store.sync(() => client.catalog())} sandbox games for ${config.APIMATIC_CURRENCY}.`,
        );
      } catch (error) {
        if (!watch) throw error;
        console.error(
          `Catalogue sync failed; existing games were retained. ${providerDiagnostic(error)}`,
        );
      }
      if (watch)
        await setTimeout(15 * 60000, undefined, {
          signal: controller.signal,
        }).catch(() => {});
    } while (watch && !controller.signal.aborted);
  } finally {
    await database.close();
  }
}
main().catch((error: unknown) => {
  console.error(providerDiagnostic(error));
  process.exitCode = 1;
});

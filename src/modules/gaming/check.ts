import { loadConfig } from "../../config/env.js";
import { ApiMaticClient } from "./client.js";
import {
  gamingReady,
  requireSandboxCredentials,
  SANDBOX_BASE_URL,
} from "./config.js";
import { providerDiagnostic } from "./provider-error.js";

async function main() {
  // Validate locally before making any request; configuration errors never contain values.
  let config;
  try {
    config = loadConfig();
    requireSandboxCredentials(config);
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Invalid sandbox configuration.",
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    `Checking ${SANDBOX_BASE_URL} for ${config.APIMATIC_CURRENCY} (one catalog request; no game launch).`,
  );
  const result = await new ApiMaticClient(config).catalogPage(1, 10);
  console.log(
    `PASS: sandbox authentication and catalog response verified. ${result.meta.total} games available for ${config.APIMATIC_CURRENCY}.`,
  );
  if (result.meta.total === 0)
    console.log(
      "No games are granted/enabled for this currency. Check Currency & Games in the provider back office.",
    );
  console.log(
    "Run npm run games:sync to import the complete catalog into MySQL.",
  );
  if (!config.APIMATIC_CALLBACK_URL)
    console.log(
      "PENDING: add the public HTTPS APIMATIC_CALLBACK_URL and configure the same sandbox callback for this currency in the provider back office.",
    );
  if (!config.APIMATIC_ENABLED)
    console.log(
      "PENDING: game launches are disabled. Set APIMATIC_ENABLED=true only after callback configuration, then restart the backend.",
    );
  if (gamingReady(config))
    console.log(
      "Local launch configuration is complete. Provider callback settings, public reachability, and actual gameplay still need verification.",
    );
}

main().catch((error: unknown) => {
  console.error(providerDiagnostic(error));
  process.exitCode = 1;
});

import type { Config } from "../../config/env.js";
import { AuthError } from "../auth/types.js";

export const SANDBOX_BASE_URL = "https://sandbox-api.api-matic.com";

export function requireSandboxCredentials(config: Config) {
  if (!config.APIMATIC_API_KEY.startsWith("uks_"))
    throw new Error(
      "Set APIMATIC_API_KEY to your sandbox key (uks_) in the backend .env.",
    );
  if (!/^[a-fA-F0-9]{64}$/.test(config.APIMATIC_SECRET_KEY))
    throw new Error(
      "Set APIMATIC_SECRET_KEY to the matching 64-character hexadecimal sandbox secret.",
    );
}
export function gamingReady(config: Config) {
  return (
    config.APIMATIC_ENABLED &&
    catalogReady(config) &&
    !!config.APIMATIC_CALLBACK_URL
  );
}
export function catalogReady(config: Config) {
  return (
    config.DB_ENABLED &&
    config.APIMATIC_API_KEY.startsWith("uks_") &&
    /^[a-fA-F0-9]{64}$/.test(config.APIMATIC_SECRET_KEY)
  );
}
export function requireCatalog(config: Config) {
  if (!catalogReady(config))
    throw new AuthError(
      503,
      "GAMES_NOT_CONFIGURED",
      "Provider games are not available yet. Please try again later.",
    );
}
export function requireGaming(config: Config) {
  if (!gamingReady(config))
    throw new AuthError(
      503,
      "GAMES_NOT_CONFIGURED",
      "Provider games are not available yet. Please try again later.",
    );
}

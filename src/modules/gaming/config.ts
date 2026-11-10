import type { Config } from "../../config/env.js";
import { validApiMaticKey, validApiMaticSecret } from "../../config/apimatic-credentials.js";
import { AuthError } from "../auth/types.js";

export const SANDBOX_BASE_URL = "https://sandbox-api.api-matic.com";

export function requireSandboxCredentials(config: Config) {
  if (!validApiMaticKey(config.APIMATIC_API_KEY))
    throw new Error(
      "Set APIMATIC_API_KEY to the key issued for your sandbox account in the backend .env, without embedded whitespace or control characters. No prefix is required.",
    );
  if (!validApiMaticSecret(config.APIMATIC_SECRET_KEY))
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
    validApiMaticKey(config.APIMATIC_API_KEY) &&
    validApiMaticSecret(config.APIMATIC_SECRET_KEY)
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

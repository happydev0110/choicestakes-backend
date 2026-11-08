import { AuthError } from "../auth/types.js";

const hints: Record<string, string> = {
  MISSING_SIGNATURE:
    "Check that the provider authentication headers reach API-MATIC.",
  INVALID_SIGNATURE:
    "Check that the sandbox API key and secret are the matching pair from Profile > Security.",
  STALE_TIMESTAMP:
    "Synchronize this computer's clock; the provider allows a five-minute difference.",
  REPLAY_DETECTED: "Retry with a fresh nonce and timestamp.",
  INVALID_API_KEY:
    "Check whether the sandbox key was regenerated, deactivated, or copied from the wrong environment.",
  BAD_REQUEST:
    "Check the configured currency and request fields against the provider specification.",
  CURRENCY_NOT_ALLOWED:
    "Ask the provider to grant the configured currency to your sandbox account.",
  CURRENCY_DISABLED:
    "Enable the configured currency in the provider back office.",
  CURRENCY_UNSUPPORTED_DECIMALS:
    "Confirm that the provider supports this currency's decimal precision.",
  CALLBACK_URL_NOT_CONFIGURED:
    "Set the sandbox callback for this currency in the provider back office.",
  CALLBACK_UNRESPONSIVE:
    "Restore public HTTPS access to the callback and wait for the provider's temporary suspension to expire.",
  GAME_NOT_ALLOWED:
    "Synchronize the catalog and check that the game is granted to your account.",
  GAME_DISABLED:
    "Enable the game in the provider back office or select another game.",
  GAME_NOT_FOUND: "Synchronize the catalog; this game may have been removed.",
  GAME_DEMO_UNSUPPORTED:
    "This game has no demo mode; use sandbox play with test credits.",
  GAME_CURRENCY_UNSUPPORTED:
    "Select a game that supports the configured currency.",
  GAME_UNAVAILABLE: "Select another game or retry later.",
  VENDOR_NOT_CONFIGURED:
    "Ask the provider to enable this vendor in the sandbox.",
  VENDOR_UNAVAILABLE: "The game vendor is unavailable; retry later.",
  VENDOR_ERROR:
    "The vendor rejected the launch; ask provider support if it persists.",
  RATE_LIMITED: "Wait before retrying; the provider is rate limiting requests.",
  DB_ERROR: "The provider reported a database error; retry later.",
  SERVICE_UNAVAILABLE:
    "The provider service is temporarily unavailable; retry later.",
};
const playerCodes = new Set([
  "GAME_NOT_ALLOWED",
  "GAME_DISABLED",
  "GAME_NOT_FOUND",
  "GAME_DEMO_UNSUPPORTED",
  "GAME_CURRENCY_UNSUPPORTED",
  "GAME_UNAVAILABLE",
  "VENDOR_NOT_CONFIGURED",
]);

export class ApiMaticError extends AuthError {
  readonly providerCode: string;
  constructor(
    public providerStatus: number,
    code: string,
  ) {
    // Keep arbitrary upstream messages and unknown codes out of logs and player responses.
    const safeCode =
      providerStatus === 429
        ? "RATE_LIMITED"
        : Object.hasOwn(hints, code)
          ? code
          : "PROVIDER_UNAVAILABLE";
    super(
      502,
      playerCodes.has(safeCode) ? safeCode : "PROVIDER_UNAVAILABLE",
      safeCode === "GAME_DEMO_UNSUPPORTED"
        ? "This game does not support demo mode. Try sandbox play."
        : "This game is currently unavailable. Please try another game.",
    );
    this.providerCode = safeCode;
  }
}

export function providerDiagnostic(error: unknown) {
  if (error instanceof ApiMaticError)
    return `API-MATIC HTTP ${error.providerStatus}: ${error.providerCode}. ${hints[error.providerCode] ?? "Check provider availability and contact support if it persists."}`;
  if (error instanceof AuthError) return `${error.code}: ${error.message}`;
  return "The check failed. Review the local configuration and provider availability; credentials were not printed.";
}

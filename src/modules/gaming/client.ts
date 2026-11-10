import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { z } from "zod";
import type { Config } from "../../config/env.js";
import { AuthError } from "../auth/types.js";
import { gameSchema, type ProviderGame } from "./contracts.js";
import { SANDBOX_BASE_URL } from "./config.js";
import { signRequest } from "./signing.js";
import { ApiMaticError } from "./provider-error.js";

export function safePlayLink(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !url.hostname.includes(".") ||
    isIP(url.hostname.replace(/^\[|\]$/g, "")) ||
    /(?:^|\.)(localhost|local|internal|test|invalid)$/.test(url.hostname)
  )
    throw new Error("Invalid provider play URL");
  return url.href;
}
const pageSchema = z.object({
  success: z.literal(true),
  data: z.array(gameSchema).default([]),
  meta: z.object({
    page: z.number().int().positive(),
    per_page: z.number().int().positive(),
    total: z.number().int().min(0).max(100000),
    last_page: z.number().int().min(0).max(1000),
  }),
});
const launchSchema = z.object({
  success: z.literal(true),
  data: z.object({
    link: z.string().url(),
    vendor_session_id: z.string().min(1).max(512),
    environment: z.literal("sandbox"),
  }),
});

export class ApiMaticClient {
  constructor(
    private config: Config,
    private fetcher: typeof fetch = fetch,
  ) {}
  private async call(
    method: "GET" | "POST",
    path: string,
    payload?: unknown,
    gameId?: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const raw = payload === undefined ? "" : JSON.stringify(payload);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = randomBytes(16).toString("hex");
    let response: Response;
    try {
      response = await this.fetcher(SANDBOX_BASE_URL + path, {
        method,
        redirect: "error",
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(8000)])
          : AbortSignal.timeout(8000),
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": this.config.APIMATIC_API_KEY,
          "X-Timestamp": timestamp,
          "X-Nonce": nonce,
          "X-Sign": signRequest(
            this.config.APIMATIC_SECRET_KEY,
            timestamp,
            nonce,
            method,
            path,
            raw,
          ),
          ...(gameId ? { "X-Game-UUID": gameId } : {}),
        },
        ...(method === "POST" ? { body: raw } : {}),
      });
    } catch {
      if (signal?.aborted)
        throw new AuthError(
          503,
          "CATALOG_SYNC_CANCELLED",
          "Catalog sync stopped during shutdown.",
        );
      throw new AuthError(
        502,
        "PROVIDER_UNREACHABLE",
        "The game provider did not respond. Please try again later.",
      );
    }
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const parsed = z
        .object({ error: z.object({ code: z.string() }) })
        .safeParse(body);
      const code = parsed.success
        ? parsed.data.error.code
        : "PROVIDER_UNAVAILABLE";
      throw new ApiMaticError(response.status, code);
    }
    return body;
  }
  async catalogPage(page = 1, perPage = 100, signal?: AbortSignal) {
    if (
      !Number.isInteger(page) ||
      page < 1 ||
      page > 1000 ||
      !Number.isInteger(perPage) ||
      perPage < 1 ||
      perPage > 100
    )
      throw new Error("Invalid catalog page.");
    const result = pageSchema.safeParse(
      await this.call(
        "GET",
        `/api/v1/games?currency=${encodeURIComponent(this.config.APIMATIC_CURRENCY)}&per_page=${perPage}&page=${page}`,
        undefined,
        undefined,
        signal,
      ),
    );
    if (!result.success)
      throw new AuthError(
        502,
        "INVALID_PROVIDER_RESPONSE",
        "The provider returned an unexpected catalog format. No games were imported.",
      );
    return result.data;
  }
  async catalog(signal?: AbortSignal): Promise<ProviderGame[]> {
    const games: ProviderGame[] = [];
    let total: number | undefined;
    let lastPage = 1;
    for (let page = 1; page <= lastPage; page++) {
      const result = await this.catalogPage(page, 100, signal);
      if (
        result.meta.page !== page ||
        (total !== undefined &&
          (result.meta.total !== total || result.meta.last_page !== lastPage))
      )
        throw new AuthError(
          502,
          "CATALOG_CHANGED",
          "Catalogue changed during sync; retry the full sync.",
        );
      total = result.meta.total;
      lastPage = result.meta.last_page;
      games.push(...result.data);
    }
    if (
      games.length !== total ||
      new Set(games.map((game) => game.uuid)).size !== games.length
    )
      throw new AuthError(
        502,
        "INCOMPLETE_CATALOG",
        "Incomplete or duplicate provider catalogue; existing catalogue retained.",
      );
    return games;
  }
  async launch(playerId: string, gameId: string, mode: "demo" | "real") {
    const result = launchSchema.parse(
      await this.call(
        "POST",
        "/api/v1/game/launch",
        {
          player_id: playerId,
          currency: this.config.APIMATIC_CURRENCY,
          lang: "en",
          gametype: mode,
        },
        gameId,
      ),
    );
    return {
      sessionId: result.data.vendor_session_id,
      link: safePlayLink(result.data.link),
    };
  }
}

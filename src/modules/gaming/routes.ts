import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Config } from "../../config/env.js";
import { AuthError, type AuthStore } from "../auth/types.js";
import { sessionCookieName, tokenHash } from "../auth/routes.js";
import {
  catalogReady,
  gamingReady,
  requireCatalog,
  requireGaming,
} from "./config.js";
import type { ApiMaticClient } from "./client.js";
import type { GamingStore } from "./store.js";
import { postbackSchema } from "./contracts.js";
import { verifyPostback } from "./signing.js";
import { callbackReply } from "./money.js";
import { WalletError } from "./wallet.js";

export async function registerGamingRoutes(
  app: FastifyInstance,
  config: Config,
  auth: AuthStore,
  store: GamingStore,
  client: Pick<ApiMaticClient, "launch">,
) {
  async function player(request: FastifyRequest) {
    const token = request.cookies[sessionCookieName(config)];
    const user =
      token && /^[A-Za-z0-9_-]{43}$/.test(token)
        ? await auth.findSession(
            tokenHash(token),
            new Date(),
            config.SESSION_IDLE_MINUTES,
          )
        : null;
    if (!user)
      throw new AuthError(401, "UNAUTHENTICATED", "Please log in to play.");
    return user;
  }
  await app.register(
    async (gaming) => {
      gaming.addHook("onRequest", async (_request, reply) => {
        reply.header("Cache-Control", "no-store");
      });
      gaming.get("/games", async (request) => {
        const parsed = z
          .object({
            page: z.coerce.number().int().min(1).max(10000).default(1),
            search: z.string().max(100).default(""),
            provider: z.string().max(128).default(""),
          })
          .safeParse(request.query);
        if (!parsed.success)
          throw new AuthError(400, "INVALID_FILTERS", "Invalid game filters.");
        const configured = catalogReady(config);
        const data = configured
          ? await store.catalog(
              parsed.data.page,
              parsed.data.search,
              parsed.data.provider,
            )
          : {
              games: [],
              total: 0,
              providers: [],
              page: 1,
              perPage: 28,
              syncedAt: null,
            };
        return {
          success: true,
          data: {
            ...data,
            configured,
            launchEnabled: gamingReady(config),
            currency: config.APIMATIC_CURRENCY,
            environment: "sandbox",
          },
        };
      });
      gaming.get<{ Params: { id: string } }>("/games/:id", async (request) => {
        requireCatalog(config);
        if (!z.string().uuid().safeParse(request.params.id).success)
          throw new AuthError(404, "GAME_NOT_FOUND", "Game not found.");
        const game = await store.game(request.params.id);
        if (!game)
          throw new AuthError(
            404,
            "GAME_NOT_FOUND",
            "This game is no longer available.",
          );
        return {
          success: true,
          data: {
            game,
            launchEnabled: gamingReady(config),
            currency: config.APIMATIC_CURRENCY,
            environment: "sandbox",
          },
        };
      });
      gaming.get("/wallet", async (request) => {
        const user = await player(request);
        requireGaming(config);
        return {
          success: true,
          data: { ...(await store.wallet(user.id)), environment: "sandbox" },
        };
      });
      gaming.post<{ Params: { id: string } }>(
        "/games/:id/launch",
        {
          bodyLimit: 8192,
          config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
        },
        async (request) => {
          if (
            !config.CORS_ORIGINS.includes(request.headers.origin ?? "") ||
            request.headers["x-requested-with"] !== "choicestakes"
          )
            throw new AuthError(
              403,
              "ORIGIN_NOT_ALLOWED",
              "This request is not allowed.",
            );
          const user = await player(request);
          requireGaming(config);
          const parsed = z
            .object({
              requestId: z.string().uuid(),
              mode: z.enum(["demo", "real"]).default("real"),
            })
            .strict()
            .safeParse(request.body);
          if (
            !parsed.success ||
            !z.string().uuid().safeParse(request.params.id).success
          )
            throw new AuthError(
              400,
              "INVALID_LAUNCH",
              "Invalid game launch request.",
            );
          const game = await store.game(request.params.id);
          if (!game)
            throw new AuthError(
              404,
              "GAME_NOT_FOUND",
              "This game is no longer available.",
            );
          const launchId = await store.claimLaunch(
            user.id,
            game.uuid,
            parsed.data.requestId,
            parsed.data.mode,
          );
          try {
            // The client is hard-wired to the sandbox host. A "real" vendor mode still uses test credits here.
            const launch = await client.launch(
              user.id,
              game.uuid,
              parsed.data.mode,
            );
            await store.completeLaunch(launchId, launch.sessionId);
            return {
              success: true,
              data: { link: launch.link, launchId, environment: "sandbox" },
            };
          } catch (error) {
            const code =
              error instanceof AuthError ? error.code : "LAUNCH_FAILED";
            await store.failLaunch(launchId, code);
            if (
              ["GAME_NOT_ALLOWED", "GAME_DISABLED", "GAME_NOT_FOUND"].includes(
                code,
              )
            )
              await store.disableGame(game.uuid);
            // Never automatically retry launches: a timeout may have already created a provider session.
            if (error instanceof AuthError) throw error;
            throw new AuthError(
              502,
              "LAUNCH_FAILED",
              "Unable to open this game. Please try again later.",
            );
          }
        },
      );
    },
    { prefix: "/api/v1/gaming" },
  );

  await app.register(async (callbacks) => {
    callbacks.removeContentTypeParser("application/json");
    callbacks.addContentTypeParser(
      "application/json",
      { parseAs: "buffer", bodyLimit: 1024 * 1024 },
      (_request, body, done) => done(null, body),
    );
    callbacks.post(
      "/api/v1/provider/apimatic/sandbox",
      async (request, reply) => {
        reply.header("Cache-Control", "no-store");
        if (!gamingReady(config))
          return reply.code(503).send({ error_code: "NOT_CONFIGURED" });
        const raw = request.body;
        if (!Buffer.isBuffer(raw))
          return reply.code(400).send({ error_code: "INVALID_BODY" });
        const nonceHash = verifyPostback(
          config.APIMATIC_SECRET_KEY,
          request.headers,
          request.url.split("?")[0]!,
          raw,
        );
        if (!nonceHash)
          return reply.code(401).send({ error_code: "INVALID_SIGNATURE" });
        let value: unknown;
        try {
          value = JSON.parse(raw.toString("utf8"));
        } catch {
          return reply.code(400).send({ error_code: "INVALID_BODY" });
        }
        const parsed = postbackSchema.safeParse(value);
        if (!parsed.success)
          return reply.code(400).send({ error_code: "INVALID_BODY" });
        try {
          const result = await store.postback(parsed.data, nonceHash);
          if (result.errorCode)
            return reply.send({ error_code: result.errorCode });
          return reply
            .type("application/json")
            .send(
              callbackReply(
                result.wallet.units,
                result.wallet.decimals,
                result.transactionId,
              ),
            );
        } catch (error) {
          const code =
            error instanceof WalletError ? error.code : "WALLET_UNAVAILABLE";
          if (code !== "REPLAY_DETECTED") {
            await store
              .issue(parsed.data, code)
              .catch(() =>
                request.log.error("Unable to persist callback issue"),
              );
            request.log.warn(
              { code, action: parsed.data.action },
              "Sandbox callback needs review",
            );
          }
          return reply
            .code(code === "REPLAY_DETECTED" ? 401 : 503)
            .send({ error_code: code });
        }
      },
    );
  });
}

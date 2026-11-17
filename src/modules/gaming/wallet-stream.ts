import { PassThrough } from "node:stream";
import type { FastifyInstance } from "fastify";
import type { Config } from "../../config/env.js";
import { AuthError, type AuthStore } from "../auth/types.js";
import { sessionCookieName, tokenHash } from "../auth/routes.js";
import { requireGaming } from "./config.js";
import type { WalletEvents } from "./wallet-events.js";

export function registerWalletStream(app: FastifyInstance, config: Config, auth: AuthStore, events: WalletEvents) {
  const connections = new Map<string, Set<() => void>>();
  let count = 0;
  let stopping = false;
  app.addHook("preClose", async () => {
    stopping = true;
    for (const group of [...connections.values()]) for (const close of [...group]) close();
  });
  app.get("/wallet/events", { exposeHeadRoute: false, config: { rateLimit: { max: 30, timeWindow: "1 minute",
    keyGenerator: (request) => tokenHash(request.cookies[sessionCookieName(config)] ?? request.ip),
  } } }, async (request, reply) => {
    const origin = request.headers.origin;
    if ((origin && !config.CORS_ORIGINS.includes(origin)) || request.headers["sec-fetch-site"] === "cross-site")
      throw new AuthError(403, "ORIGIN_NOT_ALLOWED", "This request is not allowed.");
    const token = request.cookies[sessionCookieName(config)];
    const hash = token && /^[A-Za-z0-9_-]{43}$/.test(token) ? tokenHash(token) : null;
    const session = () => hash ? auth.findSession(hash, new Date(), config.SESSION_IDLE_MINUTES, false) : Promise.resolve(null);
    const player = await session();
    if (!player) throw new AuthError(401, "UNAUTHENTICATED", "Please log in to continue.");
    requireGaming(config);
    if (stopping || !events.ready()) throw new AuthError(503, "WALLET_STREAM_UNAVAILABLE", "Live balance updates are temporarily unavailable.");
    const group = connections.get(player.id) ?? new Set<() => void>();
    if (group.size >= 8 || count >= 2000) {
      reply.header("Retry-After", "10");
      throw new AuthError(429, "TOO_MANY_CONNECTIONS", "Too many live balance connections.");
    }
    const stream = new PassThrough({ highWaterMark: 4096 });
    let closed = false;
    let checking = false;
    let pending = false;
    let changed = false;
    let unsubscribe = () => {};
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      group.delete(close);
      count--;
      if (!group.size) connections.delete(player.id);
      request.raw.removeListener("aborted", close);
      reply.raw.removeListener("close", close);
      stream.end();
    };
    const write = (value: string) => {
      if (closed) return;
      // Disconnect slow consumers rather than accumulate unbounded notifications.
      if (!stream.write(value)) { close(); stream.destroy(); }
    };
    const check = async (walletChanged: boolean) => {
      pending = true;
      changed ||= walletChanged;
      if (checking || closed) return;
      checking = true;
      try {
        while (pending && !closed) {
          pending = false;
          const user = await session();
          if (closed) break;
          if (user?.id !== player.id) {
            write("event: session.expired\ndata: {}\n\n");
            close();
            break;
          }
          if (changed) {
            changed = false;
            write("event: wallet.updated\ndata: {}\n\n");
          } else write(": keep-alive\n\n");
        }
      } catch { close(); }
      finally { checking = false; }
    };
    group.add(close);
    connections.set(player.id, group);
    count++;
    try {
      unsubscribe = events.subscribe(player.id, (event) => {
        if (event === "stream.reset") close();
        else void check(true);
      });
    } catch { close(); throw new AuthError(503, "WALLET_STREAM_UNAVAILABLE", "Live balance updates are temporarily unavailable."); }
    request.raw.once("aborted", close);
    reply.raw.once("close", close);
    stream.once("error", close);
    // Authentication checks and heartbeat comments do not read the wallet or
    // extend session idle expiry. Actual balances are fetched only on events.
    heartbeat = setInterval(() => void check(false), 20000);
    heartbeat.unref();
    request.raw.socket.setTimeout(0);
    reply.headers({
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "private, no-cache, no-store, no-transform",
      "X-Accel-Buffering": "no",
      "X-Content-Type-Options": "nosniff",
    });
    write("retry: 5000\nevent: wallet.ready\ndata: {}\n\n");
    return reply.send(stream);
  });
}

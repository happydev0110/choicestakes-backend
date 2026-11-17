import { randomUUID } from "node:crypto";
import cluster from "node:cluster";
import { createClient } from "redis";
import type { FastifyBaseLogger } from "fastify";
import type { Config } from "../../config/env.js";

type Listener = (event: "wallet.updated" | "stream.reset") => void;
export interface WalletEvents {
  ready(): boolean;
  subscribe(playerId: string, listener: Listener): () => void;
  publish(playerId: string): void;
  close(): Promise<void>;
}

// Notifications invalidate a wallet snapshot; they never perform a wallet write.
export async function createWalletEvents(config: Config, log: FastifyBaseLogger): Promise<WalletEvents> {
  if (!config.WALLET_EVENTS_REDIS_URL && cluster.isWorker)
    throw new Error("Clustered backends require WALLET_EVENTS_REDIS_URL for live wallet updates.");
  const listeners = new Map<string, Set<Listener>>();
  const origin = randomUUID();
  let closed = false;
  const dispatch = (playerId: string, event: Parameters<Listener>[0]) => {
    for (const listener of [...(listeners.get(playerId) ?? [])]) {
      try { listener(event); } catch { log.warn("Wallet notification listener failed"); }
    }
  };
  const reset = () => {
    for (const playerId of [...listeners.keys()]) dispatch(playerId, "stream.reset");
  };
  const publisher = config.WALLET_EVENTS_REDIS_URL ? createClient({
    url: config.WALLET_EVENTS_REDIS_URL,
    disableOfflineQueue: true,
    commandsQueueMaxLength: 1000,
    socket: { connectTimeout: 5000, reconnectStrategy: (retries) => Math.min(500 * (retries + 1), 5000) },
  }) : null;
  const subscriber = publisher?.duplicate() ?? null;
  const ready = () => !closed && (!publisher || Boolean(publisher.isReady && subscriber?.isReady));
  if (publisher && subscriber) {
    // A lost subscription may miss notifications. Close streams so reconnecting
    // browsers fetch an authoritative snapshot after Redis recovers.
    for (const client of [publisher, subscriber]) {
      client.on("error", () => { log.warn("Wallet notification connection unavailable"); reset(); });
      client.on("reconnecting", reset);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        (async () => {
          await Promise.all([publisher.connect(), subscriber.connect()]);
          await subscriber.subscribe(config.WALLET_EVENTS_REDIS_CHANNEL, (raw) => {
            try {
              const message: unknown = JSON.parse(raw);
              if (!message || typeof message !== "object") return;
              const { source, playerId } = message as Record<string, unknown>;
              if (source !== origin && typeof source === "string" && typeof playerId === "string" && playerId.length <= 128)
                dispatch(playerId, "wallet.updated");
            } catch { /* Ignore malformed notifications; MySQL remains authoritative. */ }
          });
        })(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Wallet notification service did not connect")), 6000); }),
      ]);
    } catch {
      if (publisher.isOpen) publisher.destroy();
      if (subscriber.isOpen) subscriber.destroy();
      throw new Error("Wallet notification service did not connect. Check WALLET_EVENTS_REDIS_URL.");
    } finally { clearTimeout(timer); }
  }
  return {
    ready,
    subscribe(playerId, listener) {
      if (!ready()) throw new Error("Wallet notifications unavailable");
      const group = listeners.get(playerId) ?? new Set<Listener>();
      group.add(listener);
      listeners.set(playerId, group);
      return () => { group.delete(listener); if (!group.size) listeners.delete(playerId); };
    },
    publish(playerId) {
      if (closed) return;
      dispatch(playerId, "wallet.updated");
      if (!publisher) return;
      if (!ready()) { reset(); return; }
      // Publication must never delay or fail a successfully committed callback.
      void publisher.publish(config.WALLET_EVENTS_REDIS_CHANNEL, JSON.stringify({ source: origin, playerId }))
        .catch(() => { log.warn("Wallet notification delivery interrupted"); reset(); });
    },
    async close() {
      closed = true;
      reset();
      listeners.clear();
      if (publisher?.isOpen) publisher.destroy();
      if (subscriber?.isOpen) subscriber.destroy();
    },
  };
}

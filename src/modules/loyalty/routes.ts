import type { FastifyInstance } from "fastify";
import type { RowDataPacket } from "mysql2/promise";
import { z } from "zod";
import type { Database } from "../../database/mysql.js";
import type { Config } from "../../config/env.js";
import { AuthError, type AuthStore } from "../auth/types.js";
import { sessionCookieName, tokenHash } from "../auth/routes.js";

export const tierCodes = [
  "basic",
  "bronze",
  "silver",
  "gold",
  "platinum",
  "diamond",
] as const;
const decimal = /^(?:0|[1-9]\d{0,8})(?:\.\d{1,2})?$/;
const units = (value: string) => {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, "0"));
};
const xp = (value: bigint) =>
  `${value / 100n}.${String(value % 100n).padStart(2, "0")}`;
const tiersSchema = z
  .array(
    z
      .object({ code: z.enum(tierCodes), minXp: z.string().regex(decimal) })
      .strict(),
  )
  .length(6)
  .refine(
    (tiers) =>
      tiers.every(
        (tier, index) =>
          tier.code === tierCodes[index] && decimal.test(tier.minXp),
      ) &&
      units(tiers[0]!.minXp) === 0n &&
      tiers.every(
        (tier, index) =>
          !index || units(tier.minXp) > units(tiers[index - 1]!.minXp),
      ),
  );

// Read the admin-owned schema without importing or exposing any admin API.
export function loyaltyView(
  raw: unknown,
  balance: string | null,
  version: number,
) {
  const tiers = tiersSchema.parse(
    typeof raw === "string" ? JSON.parse(raw) : raw,
  );
  const value =
    balance === null
      ? null
      : BigInt(
          z
            .string()
            .regex(/^\d{1,11}$/)
            .parse(balance),
        );
  const index =
    value === null
      ? -1
      : tiers.findLastIndex((tier) => value >= units(tier.minXp));
  const current = tiers[index],
    next = tiers[index + 1];
  return {
    environment: "sandbox" as const,
    version,
    tiers: tiers.map((tier, i) => ({
      code: tier.code,
      minXp: xp(units(tier.minXp)),
      maxXp: tiers[i + 1] ? xp(units(tiers[i + 1]!.minXp) - 1n) : null,
    })),
    player:
      value === null || !current
        ? null
        : {
            xp: xp(value),
            tier: current.code,
            nextTier: next?.code ?? null,
            xpToNext: next ? xp(units(next.minXp) - value) : "0.00",
            progressPercent: next
              ? Number(
                  ((value - units(current.minXp)) * 10000n) /
                    (units(next.minXp) - units(current.minXp)),
                ) / 100
              : 100,
          },
  };
}
export interface LoyaltyStore {
  read(playerId?: string): Promise<ReturnType<typeof loyaltyView>>;
}
export function createLoyaltyStore(database: Database): LoyaltyStore {
  return {
    async read(playerId) {
      try {
        if (!database.enabled) throw new Error("Database unavailable");
        return await database.withConnection(async (connection) => {
          const [rows] = await connection.execute<RowDataPacket[]>(
            playerId
              ? `SELECT p.tiers_json,p.version,COALESCE(a.xp_units,0) AS xp_units FROM loyalty_programs p
               LEFT JOIN loyalty_accounts a ON a.environment=p.environment AND a.player_id=? WHERE p.environment='sandbox'`
              : "SELECT tiers_json,version FROM loyalty_programs WHERE environment='sandbox'",
            playerId ? [playerId] : [],
          );
          if (!rows[0]) throw new Error("Missing loyalty program");
          return loyaltyView(
            rows[0].tiers_json,
            playerId ? String(rows[0].xp_units) : null,
            Number(rows[0].version),
          );
        });
      } catch {
        // Never substitute sample thresholds or zero XP for a failed database read.
        throw new AuthError(
          503,
          "LOYALTY_UNAVAILABLE",
          "Loyalty information is temporarily unavailable. Please try again.",
        );
      }
    },
  };
}
export async function registerLoyaltyRoutes(
  app: FastifyInstance,
  config: Config,
  auth: AuthStore,
  store: LoyaltyStore,
) {
  await app.register(
    async (api) => {
      api.addHook("onRequest", async (_request, reply) => {
        reply.header("Cache-Control", "no-store");
      });
      api.addHook("preValidation", async (request) => {
        if (Object.keys(request.query as object).length)
          throw new AuthError(
            400,
            "INVALID_REQUEST",
            "Query parameters are not supported.",
          );
      });
      api.get("/tiers", async () => ({
        success: true,
        data: await store.read(),
      }));
      api.get("/me", async (request) => {
        const token = request.cookies[sessionCookieName(config)];
        const player =
          token && /^[A-Za-z0-9_-]{43}$/.test(token)
            ? await auth.findSession(
                tokenHash(token),
                new Date(),
                config.SESSION_IDLE_MINUTES,
                false,
              )
            : null;
        if (!player)
          throw new AuthError(
            401,
            "UNAUTHENTICATED",
            "Please log in to view your loyalty progress.",
          );
        return { success: true, data: await store.read(player.id) };
      });
    },
    { prefix: "/api/v1/loyalty" },
  );
}

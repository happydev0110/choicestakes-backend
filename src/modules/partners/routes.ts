import type { FastifyInstance } from "fastify";
import type { RowDataPacket } from "mysql2/promise";
import type { Database } from "../../database/mysql.js";
import { AuthError } from "../auth/types.js";
import { z } from "zod";

export interface PublicOffer {
  id: string;
  merchant: string;
  title: string;
  description: string;
  imageUrl: string | null;
  affiliateUrl: string;
}
export interface PublicOfferStore {
  list(
    page: number,
  ): Promise<{
    items: PublicOffer[];
    page: number;
    perPage: number;
    total: number;
  }>;
}
export function isSovrnLink(value: unknown): value is string {
  try {
    if (typeof value !== "string") return false;
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === "sovrn.co" &&
      !url.port &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}
export function createPublicOfferStore(database: Database): PublicOfferStore {
  return {
    async list(page) {
      try {
        if (!database.enabled) throw new Error("Database disabled");
        return await database.withConnection(async (connection) => {
          const [counts] = await connection.execute<RowDataPacket[]>(
            "SELECT COUNT(*) total FROM partner_offers WHERE published=TRUE AND affiliate_url IS NOT NULL",
          );
          const [rows] = await connection.query<RowDataPacket[]>(
            "SELECT id,merchant,title,description,image_url,affiliate_url FROM partner_offers WHERE published=TRUE AND affiliate_url IS NOT NULL ORDER BY sort_order,id LIMIT 12 OFFSET ?",
            [(page - 1) * 12],
          );
          return {
            page,
            perPage: 12,
            total: Number(counts[0]?.total ?? 0),
            items: rows
              .filter((row) => isSovrnLink(row.affiliate_url))
              .map((row) => ({
                id: row.id,
                merchant: row.merchant,
                title: row.title,
                description: row.description,
                imageUrl:
                  typeof row.image_url === "string" &&
                  /^https:\/\//i.test(row.image_url)
                    ? row.image_url
                    : null,
                affiliateUrl: row.affiliate_url,
              })),
          };
        });
      } catch {
        throw new AuthError(
          503,
          "PARTNERS_UNAVAILABLE",
          "Partner offers are temporarily unavailable.",
        );
      }
    },
  };
}
export async function registerPublicOfferRoutes(
  app: FastifyInstance,
  store: PublicOfferStore,
) {
  app.get("/api/v1/partner-offers", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const parsed = z
      .object({ page: z.coerce.number().int().min(1).max(10000).default(1) })
      .strict()
      .safeParse(request.query);
    if (!parsed.success)
      throw new AuthError(400, "INVALID_PAGE", "Invalid partner offers page.");
    return { success: true, data: await store.list(parsed.data.page) };
  });
}

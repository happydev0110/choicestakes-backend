import { z } from "zod";
const opaque = z.string().min(1).max(512);
const common = {
  type: z.enum(["balance", "bet", "win", "refund", "rollback"]),
  currency: z.string().min(1).max(16),
  player_id: z.string().uuid(),
  session_id: opaque,
  game_uuid: z.union([z.string().uuid(), z.literal("")]),
  transaction_id: z.string().max(512),
  transaction_datetime: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/),
  casino_request_retry_count: z.number().int().nonnegative(),
  round_id: z.string().max(512).optional(),
};
const amount = z.string().regex(/^\d{1,30}\.\d{2,3}$/);
export const postbackSchema = z
  .discriminatedUnion("action", [
    z.object({ ...common, action: z.literal("balance") }),
    z.object({
      ...common,
      action: z.literal("bet"),
      transaction_id: opaque,
      amount,
    }),
    z.object({
      ...common,
      action: z.literal("win"),
      transaction_id: opaque,
      amount,
    }),
    z.object({
      ...common,
      action: z.literal("refund"),
      transaction_id: opaque,
      amount,
      bet_transaction_id: z.string().max(512),
    }),
    z.object({
      ...common,
      action: z.literal("rollback"),
      transaction_id: opaque,
      rollback_transactions: z
        .array(
          z.object({
            transaction_id: opaque,
            type: z.string().max(32),
            amount: z.string().max(40),
            currency: z.string().min(1).max(16).optional(),
          }),
        )
        .min(1)
        .max(100),
    }),
  ])
  .refine((body) => body.type === body.action, "Action and type must match");
export type Postback = z.infer<typeof postbackSchema>;
export type Action = Postback["action"];
export const gameSchema = z.object({
  uuid: z.string().uuid(),
  code: z.string().max(255),
  name: z.string().min(1).max(255),
  provider: z.string().min(1).max(128),
  vendor: z.string().min(1).max(128),
  images: z
    .array(
      z.object({ role: z.string(), format: z.string(), url: z.string().url() }),
    )
    .optional(),
});
export type ProviderGame = z.infer<typeof gameSchema>;
export type CatalogGame = Omit<ProviderGame, "images"> & {
  imageUrl: string | null;
};

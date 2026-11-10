import { z } from "zod";

export const gameCategories = [
  "featured",
  "new-games",
  "slots",
  "live",
  "crash-instant",
  "table-cards",
  "lotto-scratch",
  "roulette",
  "poker",
] as const;

export const catalogFilters = z.object({
  page: z.coerce.number().int().min(1).max(10000).default(1),
  search: z.string().max(100).default(""),
  provider: z.string().max(128).default(""),
  category: z.union([z.literal(""), z.enum(gameCategories)]).default(""),
  sort: z.enum(["provider", "name", "name-desc"]).default("provider"),
  ids: z
    .string()
    .max(3699)
    .transform((value) => (value ? value.split(",") : []))
    .pipe(z.array(z.string().uuid()).max(100))
    .optional(),
});
export type CatalogOptions = Pick<
  z.infer<typeof catalogFilters>,
  "category" | "sort" | "ids"
>;

export const classificationFile = z
  .object({
    currency: z.string().min(1).max(16).optional(),
    assignments: z
      .array(
        z
          .object({
            uuid: z.string().uuid(),
            // Exported labels help operators review assignments; imports never change provider metadata.
            name: z.string().max(255).optional(),
            provider: z.string().max(128).optional(),
            vendor: z.string().max(128).optional(),
            categories: z
              .array(z.enum(gameCategories))
              .max(gameCategories.length)
              .refine(
                (values) => new Set(values).size === values.length,
                "Duplicate category",
              ),
          })
          .strict(),
      )
      .max(10000),
  })
  .strict()
  .refine(
    ({ assignments }) =>
      new Set(assignments.map(({ uuid }) => uuid.toLowerCase())).size ===
      assignments.length,
    "Duplicate game UUID",
  );

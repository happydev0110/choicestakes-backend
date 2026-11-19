import { z } from "zod";

// API-MATIC forwards `lang` to the vendor. This allowlist does not imply that
// every vendor supports every language; do not retry launches to change it.
export const gameLanguages = ["en", "ja", "es", "fr", "ko", "pt", "ro", "it", "zh"] as const;
export type GameLanguage = (typeof gameLanguages)[number];
export const launchRequestSchema = z.object({
  requestId: z.string().uuid(),
  mode: z.enum(["demo", "real"]).default("real"),
  lang: z.enum(gameLanguages).default("en"),
}).strict();

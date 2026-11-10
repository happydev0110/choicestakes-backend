import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type { RowDataPacket } from "mysql2/promise";
import { loadConfig } from "../../config/env.js";
import { createDatabase, type Database } from "../../database/mysql.js";
import { classificationFile } from "./catalog-filters.js";

// Operator-only CLI: no public write endpoint. Each listed game's assignments are replaced.
export async function classifyGames(
  database: Database,
  currency: string,
  input: unknown,
) {
  const { assignments } = classificationFile.parse(input);
  return database.transaction(async (connection) => {
    for (const assignment of [...assignments].sort((a, b) =>
      a.uuid.localeCompare(b.uuid),
    )) {
      const uuid = assignment.uuid.toLowerCase();
      const [games] = await connection.execute<RowDataPacket[]>(
        "SELECT game_uuid FROM apimatic_games WHERE currency=? AND game_uuid=? FOR UPDATE",
        [currency, uuid],
      );
      if (!games.length)
        throw new Error(
          `Game ${uuid} is not in the ${currency} catalog. Sync games first.`,
        );
      await connection.execute(
        "DELETE FROM apimatic_game_categories WHERE currency=? AND game_uuid=?",
        [currency, uuid],
      );
      for (const category of assignment.categories) {
        await connection.execute(
          "INSERT INTO apimatic_game_categories (currency,game_uuid,category) VALUES (?,?,?)",
          [currency, uuid, category],
        );
      }
    }
    return assignments.length;
  });
}

async function main() {
  const file = process.argv[2];
  if (!file)
    throw new Error("Usage: npm run games:classify -- ./game-categories.json");
  const input: unknown = JSON.parse(await readFile(file, "utf8"));
  const parsed = classificationFile.safeParse(input);
  if (!parsed.success)
    throw new Error(
      "Invalid classification file. Use unique game UUIDs and supported category names. See docs/provider-catalog.md.",
    );
  const config = loadConfig();
  if (!config.DB_ENABLED)
    throw new Error("Enable MySQL before classifying games.");
  const database = createDatabase(config);
  try {
    console.log(
      `Updated categories for ${await classifyGames(database, config.APIMATIC_CURRENCY, parsed.data)} games in ${config.APIMATIC_CURRENCY}.`,
    );
  } finally {
    await database.close();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error: unknown) => {
    console.error(
      error instanceof Error ? error.message : "Unable to classify games.",
    );
    process.exitCode = 1;
  });
}

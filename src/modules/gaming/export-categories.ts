import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type { RowDataPacket } from "mysql2/promise";
import { loadConfig } from "../../config/env.js";
import { createDatabase, type Database } from "../../database/mysql.js";
import { gameCategories } from "./catalog-filters.js";
import { catalogFailure } from "./catalog-sync.js";
import { providerDiagnostic } from "./provider-error.js";

export async function exportCategories(database: Database, currency: string) {
  return database.withConnection(async (connection) => {
    const [rows] = await connection.execute<RowDataPacket[]>(
      `SELECT g.game_uuid,g.name,g.provider,g.vendor,c.category
       FROM apimatic_games g LEFT JOIN apimatic_game_categories c
         ON c.currency=g.currency AND c.game_uuid=g.game_uuid
       WHERE g.currency=? AND g.available=TRUE
       ORDER BY g.provider,g.name,g.game_uuid,c.category`,
      [currency],
    );
    const assignments = new Map<
      string,
      {
        uuid: string;
        name: string;
        provider: string;
        vendor: string;
        categories: string[];
      }
    >();
    for (const row of rows) {
      let game = assignments.get(row.game_uuid);
      if (!game) {
        game = {
          uuid: row.game_uuid,
          name: row.name,
          provider: row.provider,
          vendor: row.vendor,
          categories: [],
        };
        assignments.set(game.uuid, game);
      }
      if (gameCategories.includes(row.category))
        game.categories.push(row.category);
    }
    return { currency, assignments: [...assignments.values()] };
  });
}

async function main() {
  const file = process.argv[2];
  if (!file)
    throw new Error(
      "Usage: npm run games:categories:export -- ./game-categories.json",
    );
  const config = loadConfig();
  if (!config.DB_ENABLED)
    throw new Error("Enable MySQL before exporting categories.");
  const database = createDatabase(config);
  try {
    const result = await exportCategories(
      database,
      config.APIMATIC_CURRENCY,
    ).catch((error) => {
      throw catalogFailure(error);
    });
    if (!result.assignments.length)
      throw new Error(
        "No available games to export. Run npm run games:sync first.",
      );
    // Never overwrite an operator's reviewed assignments.
    await writeFile(file, JSON.stringify(result, null, 2) + "\n", {
      flag: "wx",
    }).catch((error: unknown) => {
      throw new Error(
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "EEXIST"
          ? "That file already exists. Choose a new export filename to preserve your reviewed assignments."
          : "Unable to write the category file. Check the destination directory and permissions.",
      );
    });
    console.log(
      `Exported ${result.assignments.length} games for ${result.currency}. Edit categories using: ${gameCategories.join(", ")}.`,
    );
    console.log(
      "Names are for reference only. Import the reviewed file with npm run games:classify -- <file>.",
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
      error instanceof Error && !("code" in error)
        ? error.message
        : providerDiagnostic(error),
    );
    process.exitCode = 1;
  });
}

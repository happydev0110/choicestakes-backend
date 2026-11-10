import { createHash, randomUUID } from "node:crypto";
import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import type { Database } from "../../database/mysql.js";
import { assertAdvisoryLockAcquired } from "../../database/locks.js";
import { AuthError } from "../auth/types.js";
import { ApiMaticError } from "./provider-error.js";
import type { ProviderGame } from "./contracts.js";

export type CatalogStatus =
  | "not_synced"
  | "syncing"
  | "ready"
  | "empty"
  | "failed"
  | "stale";
export function catalogStatus(
  total: number,
  attempt: string | null,
  lastSuccess: string | null,
): CatalogStatus {
  if (attempt === "running") return "syncing";
  if (attempt === "failed") return total ? "stale" : "failed";
  if (total) return "ready";
  return lastSuccess ? "empty" : "not_synced";
}

const databaseErrors: Record<string, [string, string]> = {
  ER_NO_SUCH_TABLE: [
    "CATALOG_MIGRATIONS_REQUIRED",
    "Run npm run db:migrate in the backend before importing games.",
  ],
  ER_BAD_DB_ERROR: [
    "CATALOG_DATABASE_NOT_FOUND",
    "The configured MySQL database does not exist. Check MYSQL_DATABASE.",
  ],
  ER_ACCESS_DENIED_ERROR: [
    "CATALOG_DATABASE_ACCESS_DENIED",
    "Check the MySQL credentials and database grants.",
  ],
  ER_DBACCESS_DENIED_ERROR: [
    "CATALOG_DATABASE_ACCESS_DENIED",
    "Check the MySQL credentials and database grants.",
  ],
  ECONNREFUSED: [
    "CATALOG_DATABASE_UNREACHABLE",
    "Check MYSQL_HOST, MYSQL_PORT, and whether MySQL is running.",
  ],
  ENOTFOUND: [
    "CATALOG_DATABASE_UNREACHABLE",
    "Check MYSQL_HOST and DNS resolution.",
  ],
  ETIMEDOUT: [
    "CATALOG_DATABASE_UNREACHABLE",
    "The MySQL connection timed out.",
  ],
  EACCES: [
    "CATALOG_DATABASE_UNREACHABLE",
    "The MySQL connection was blocked. Check the host, port, server, and network permissions.",
  ],
};
export function catalogFailure(error: unknown): AuthError {
  if (error instanceof AuthError) return error;
  const code =
    error && typeof error === "object" && "code" in error
      ? String(error.code)
      : "";
  const known = databaseErrors[code];
  return new AuthError(
    503,
    known?.[0] ?? "CATALOG_SYNC_FAILED",
    known?.[1] ??
      "Catalog refresh failed; the previous catalog was retained. Check database availability and migrations.",
  );
}
function errorCode(error: AuthError) {
  return error instanceof ApiMaticError ? error.providerCode : error.code;
}

export async function readCatalogStatus(
  connection: PoolConnection,
  currency: string,
) {
  const [rows] = await connection.execute<RowDataPacket[]>(
    `SELECT g.total,g.synced_at,s.status,s.started_at,s.finished_at,s.succeeded_at,s.provider_total,s.error_code
      FROM (SELECT COUNT(*) AS total, MAX(synced_at) AS synced_at FROM apimatic_games WHERE currency=? AND available=TRUE) g
      LEFT JOIN apimatic_catalog_sync s ON s.currency=? AND s.environment='sandbox'`,
    [currency, currency],
  );
  const row = rows[0]!;
  const total = Number(row.total);
  // Existing imported catalogs remain usable when status tracking is first deployed.
  const lastSuccessAt: string | null =
    row.succeeded_at ?? row.synced_at ?? null;
  return {
    status: catalogStatus(total, row.status ?? null, lastSuccessAt),
    total,
    lastAttemptAt: (row.started_at ?? null) as string | null,
    lastSuccessAt,
    lastFinishedAt: (row.finished_at ?? null) as string | null,
    providerTotal:
      row.provider_total == null ? null : Number(row.provider_total),
    lastErrorCode: (row.error_code ?? null) as string | null,
  };
}

export async function synchronizeCatalog(
  database: Database,
  currency: string,
  fetchCatalog: () => Promise<ProviderGame[]>,
) {
  if (!database.enabled)
    throw new AuthError(
      503,
      "CATALOG_DATABASE_DISABLED",
      "Set DB_ENABLED=true before importing games.",
    );
  try {
    return await database.withConnection(async (connection) => {
      const lock =
        "apimatic_sync_" +
        createHash("sha256").update(currency).digest("hex").slice(0, 20);
      const [locks] = await connection.execute<RowDataPacket[]>(
        "SELECT GET_LOCK(?, 0) AS acquired",
        [lock],
      );
      if (locks[0]?.acquired === 0 || locks[0]?.acquired === "0") {
        throw new AuthError(
          409,
          "CATALOG_SYNC_IN_PROGRESS",
          "Another catalog import is already running.",
        );
      }
      assertAdvisoryLockAcquired(
        locks[0]?.acquired,
        "Another catalog import is already running.",
      );
      let transactionOpen = false;
      let unusable = false;
      try {
        await connection.execute(
          `INSERT INTO apimatic_catalog_sync (environment,currency,status,started_at)
           VALUES ('sandbox',?,'running',UTC_TIMESTAMP(3))
           ON DUPLICATE KEY UPDATE status='running',started_at=UTC_TIMESTAMP(3),finished_at=NULL,error_code=NULL`,
          [currency],
        );
        const games = await fetchCatalog();
        const generation = randomUUID();
        await connection.beginTransaction();
        transactionOpen = true;
        for (const game of games) {
          const images = game.images ?? [];
          const image =
            images.find((item) => item.role === "default") ?? images[0];
          let imageUrl: string | null = null;
          if (image) {
            const url = new URL(image.url);
            if (
              url.origin === "https://static.api-matic.com" &&
              !url.username &&
              !url.password
            )
              imageUrl = url.href;
          }
          await connection.execute(
            `INSERT INTO apimatic_games (currency,game_uuid,code,name,provider,vendor,image_url,available,sync_generation,synced_at)
             VALUES (?,?,?,?,?,?,?,TRUE,?,UTC_TIMESTAMP(3)) ON DUPLICATE KEY UPDATE code=VALUES(code),name=VALUES(name),provider=VALUES(provider),vendor=VALUES(vendor),image_url=VALUES(image_url),available=TRUE,sync_generation=VALUES(sync_generation),synced_at=VALUES(synced_at)`,
            [
              currency,
              game.uuid,
              game.code,
              game.name,
              game.provider,
              game.vendor,
              imageUrl,
              generation,
            ],
          );
        }
        await connection.execute(
          "UPDATE apimatic_games SET available=FALSE WHERE currency=? AND sync_generation<>?",
          [currency, generation],
        );
        // Catalog changes and successful status become visible atomically, including zero-game results.
        await connection.execute(
          "UPDATE apimatic_catalog_sync SET status='succeeded',finished_at=UTC_TIMESTAMP(3),succeeded_at=UTC_TIMESTAMP(3),provider_total=?,error_code=NULL WHERE currency=? AND environment='sandbox'",
          [games.length, currency],
        );
        await connection.commit();
        transactionOpen = false;
        return games.length;
      } catch (error) {
        if (transactionOpen) {
          try {
            await connection.rollback();
          } catch {
            unusable = true;
            connection.destroy();
          }
        }
        const failure = catalogFailure(error);
        if (!unusable)
          await connection
            .execute(
              "UPDATE apimatic_catalog_sync SET status='failed',finished_at=UTC_TIMESTAMP(3),error_code=? WHERE currency=? AND environment='sandbox'",
              [errorCode(failure), currency],
            )
            .catch(() => {});
        throw failure;
      } finally {
        if (!unusable)
          await connection
            .execute("SELECT RELEASE_LOCK(?)", [lock])
            .catch(() => {
              connection.destroy();
            });
      }
    });
  } catch (error) {
    throw catalogFailure(error);
  }
}

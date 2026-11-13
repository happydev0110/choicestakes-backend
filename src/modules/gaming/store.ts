import { createHash, randomUUID } from "node:crypto";
import type { PoolConnection, RowDataPacket, ResultSetHeader } from "mysql2/promise";
import type { Config } from "../../config/env.js";
import type { Database } from "../../database/mysql.js";
import { catalogFailure, readCatalogStatus, synchronizeCatalog } from "./catalog-sync.js";
import { AuthError } from "../auth/types.js";
import type { CatalogGame, Postback, ProviderGame } from "./contracts.js";
import {
  applyPostback,
  eventKey,
  WalletError,
  type LedgerEvent,
  type Wallet,
  type WalletTransaction,
} from "./wallet.js";
import { formatAmount, parseAmount } from "./money.js";
import { gameCategories, type CatalogOptions } from "./catalog-filters.js";
import { visibleGame } from "./visibility.js";
import { resolveCallbackSession, type CallbackLaunch } from "./callback-session.js";

type Row = RowDataPacket & Record<string, any>;
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const issueKey = (body: Postback) =>
  body.action === "balance"
    ? hash(
        JSON.stringify([
          "balance",
          body.player_id,
          body.session_id,
          body.currency,
        ]),
      )
    : eventKey(body.action, body.transaction_id);
const toGame = (row: Row): CatalogGame => ({
  uuid: row.game_uuid,
  code: row.code,
  name: row.name,
  provider: row.provider,
  vendor: row.vendor,
  imageUrl: row.image_url,
});
const toCallbackLaunch = (row: Row): CallbackLaunch => ({
  id: row.id,
  playerId: row.player_id,
  gameId: row.game_uuid,
  currency: row.currency,
  status: row.status,
  vendorSessionId: row.vendor_session_id,
});

async function lockLaunchOwner(connection: PoolConnection, id: string) {
  const [launches] = await connection.execute<Row[]>(
    "SELECT player_id FROM apimatic_launches WHERE id=?",
    [id],
  );
  if (!launches[0]) throw new AuthError(409, "LAUNCH_NOT_FOUND", "Game launch no longer exists.");
  // Same lock order as claimLaunch/postback. Never hold this lock across a provider call.
  await connection.execute("SELECT id FROM players WHERE id=? FOR UPDATE", [launches[0].player_id]);
}
function toEvent(row: Row): LedgerEvent {
  return {
    action: row.action,
    id: row.transaction_id,
    playerId: row.player_id,
    currency: row.currency,
    sessionId: row.session_id,
    roundId: row.round_id,
    gameId: row.game_uuid,
    fingerprint: row.fingerprint,
    amount: BigInt(row.amount_units),
    delta: BigInt(row.delta_units),
    reversed: !!row.reversed,
    errorCode: row.error_code,
  };
}
function walletTransaction(
  connection: PoolConnection,
  playerId: string,
  operationKey?: string,
): WalletTransaction {
  return {
    async wallet(currency) {
      const [rows] = await connection.execute<Row[]>(
        "SELECT * FROM apimatic_sandbox_wallets WHERE player_id = ? AND currency = ? FOR UPDATE",
        [playerId, currency],
      );
      if (!rows[0]) throw new WalletError("WALLET_NOT_FOUND");
      return {
        currency,
        decimals: rows[0].decimals,
        units: BigInt(rows[0].balance_units),
      };
    },
    async updateWallet(wallet) {
      const [rows] = await connection.execute<Row[]>(
        "SELECT balance_units FROM apimatic_sandbox_wallets WHERE player_id=? AND currency=? FOR UPDATE",
        [playerId, wallet.currency],
      );
      if (!rows[0]) throw new WalletError("WALLET_NOT_FOUND");
      const delta = wallet.units - BigInt(rows[0].balance_units);
      if (delta !== 0n && operationKey) {
        await connection.execute(
          `INSERT INTO apimatic_sandbox_movements (movement_key,event_key,player_id,currency,delta_units) VALUES (?,?,?,?,?)
          ON DUPLICATE KEY UPDATE delta_units=delta_units+VALUES(delta_units)`,
          [
            hash(operationKey + ":" + wallet.currency),
            operationKey,
            playerId,
            wallet.currency,
            delta.toString(),
          ],
        );
      }
      await connection.execute(
        "UPDATE apimatic_sandbox_wallets SET balance_units = ? WHERE player_id = ? AND currency = ?",
        [wallet.units.toString(), playerId, wallet.currency],
      );
    },
    async event(action, id) {
      const [rows] = await connection.execute<Row[]>(
        "SELECT * FROM apimatic_sandbox_ledger WHERE event_key = ?",
        [eventKey(action, id)],
      );
      return rows[0] ? toEvent(rows[0]) : null;
    },
    async saveEvent(event) {
      const [existing] = await connection.execute<Row[]>(
        "SELECT player_id,currency,fingerprint FROM apimatic_sandbox_ledger WHERE event_key = ?",
        [eventKey(event.action, event.id)],
      );
      if (existing[0]) {
        if (
          existing[0].player_id !== event.playerId ||
          existing[0].currency !== event.currency ||
          existing[0].fingerprint !== event.fingerprint
        )
          throw new WalletError("TRANSACTION_CONFLICT");
        await connection.execute(
          "UPDATE apimatic_sandbox_ledger SET reversed = ? WHERE event_key = ?",
          [event.reversed, eventKey(event.action, event.id)],
        );
        return;
      }
      await connection.execute(
        `INSERT INTO apimatic_sandbox_ledger
        (event_key,action,transaction_id,player_id,currency,session_id,round_id,game_uuid,fingerprint,amount_units,delta_units,reversed,error_code)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          eventKey(event.action, event.id),
          event.action,
          event.id,
          event.playerId,
          event.currency,
          event.sessionId,
          event.roundId,
          event.gameId,
          event.fingerprint,
          event.amount.toString(),
          event.delta.toString(),
          event.reversed,
          event.errorCode,
        ],
      );
    },
    async refundCandidates(body) {
      if (!body.round_id) return [];
      const [rows] = await connection.execute<Row[]>(
        `SELECT * FROM apimatic_sandbox_ledger
        WHERE player_id = ? AND currency = ? AND round_id = ? AND game_uuid = ? AND action = 'bet' LIMIT 2`,
        [playerId, body.currency, body.round_id, body.game_uuid],
      );
      return rows.map(toEvent);
    },
  };
}

export function createGamingStore(database: Database, config: Config) {
  async function ready<T>(work: () => Promise<T>) {
    if (!database.enabled)
      throw new AuthError(
        503,
        "GAMES_UNAVAILABLE",
        "Provider games are temporarily unavailable.",
      );
    try {
      return await work();
    } catch (error) {
      if (error instanceof AuthError || error instanceof WalletError)
        throw error;
      throw new AuthError(
        503,
        "GAMES_UNAVAILABLE",
        "Provider games are temporarily unavailable.",
      );
    }
  }
  return {
    async catalog(page: number, search: string, provider: string, options: Partial<CatalogOptions> = {}) {
      return ready(() =>
        database.withConnection(async (connection) => {
          const pattern = "%" + search.replace(/[=%_]/g, "=$&") + "%";
          let where =
            `g.currency = ? AND g.available = TRUE AND ${visibleGame} AND (g.name LIKE ? ESCAPE '=' OR g.provider LIKE ? ESCAPE '=') AND (? = '' OR g.provider = ?)`;
          const params: (string | number)[] = [
            config.APIMATIC_CURRENCY,
            pattern,
            pattern,
            provider,
            provider,
          ];
          if (options.category) {
            where += " AND EXISTS (SELECT 1 FROM apimatic_game_categories c WHERE c.currency=g.currency AND c.game_uuid=g.game_uuid AND c.category=?)";
            params.push(options.category);
          }
          if (options.ids !== undefined) {
            where += options.ids.length ? ` AND g.game_uuid IN (${options.ids.map(() => "?").join(",")})` : " AND FALSE";
            params.push(...options.ids.map((id) => id.toLowerCase()));
          }
          const [counts] = await connection.execute<Row[]>(
            `SELECT COUNT(*) AS total, MAX(g.synced_at) AS synced_at FROM apimatic_games g WHERE ${where}`,
            params,
          );
          const total = Number(counts[0]?.total ?? 0);
          const currentPage = Math.min(page, Math.max(1, Math.ceil(total / 28)));
          const order = options.sort === "name" ? "g.name, g.game_uuid"
            : options.sort === "name-desc" ? "g.name DESC, g.game_uuid" : "g.provider, g.name, g.game_uuid";
          const [rows] = await connection.query<Row[]>(
            `SELECT g.* FROM apimatic_games g WHERE ${where} ORDER BY ${order} LIMIT 28 OFFSET ?`,
            [...params, (currentPage - 1) * 28],
          );
          const [providers] = await connection.execute<Row[]>(
            `SELECT g.provider, COUNT(*) AS total FROM apimatic_games g WHERE g.currency = ? AND g.available = TRUE AND ${visibleGame} GROUP BY g.provider ORDER BY g.provider`,
            [config.APIMATIC_CURRENCY],
          );
          const status = await readCatalogStatus(connection, config.APIMATIC_CURRENCY);
          return {
            games: rows.map(toGame),
            total,
            page: currentPage,
            perPage: 28,
            providers: providers.map((row) => String(row.provider)),
            providerCounts: providers.map((row) => ({ provider: String(row.provider), total: Number(row.total) })),
            syncedAt: status.lastSuccessAt,
            catalog: {
              status: status.status,
              total: status.total,
              lastAttemptAt: status.lastAttemptAt,
              lastSuccessAt: status.lastSuccessAt,
            },
          };
        }),
      );
    },
    async lobby() {
      const catalog = await this.catalog(1, "", "");
      const sections = await ready(() => database.withConnection(async (connection) => {
        // Rank within each reviewed category before limiting: never classify from a partial catalog page.
        const [rows] = await connection.execute<Row[]>(
          `SELECT * FROM (
            SELECT g.*,c.category,
              ROW_NUMBER() OVER (PARTITION BY c.category ORDER BY g.name,g.game_uuid) AS position,
              COUNT(*) OVER (PARTITION BY c.category) AS category_total
            FROM apimatic_game_categories c JOIN apimatic_games g
              ON g.currency=c.currency AND g.game_uuid=c.game_uuid
            WHERE g.currency=? AND g.available=TRUE AND ${visibleGame}
          ) ranked WHERE position<=16 ORDER BY category,position`,
          [config.APIMATIC_CURRENCY],
        );
        return gameCategories.map((category) => {
          const games = rows.filter((row) => row.category === category);
          return { category, total: Number(games[0]?.category_total ?? 0), games: games.map(toGame) };
        });
      }));
      return { ...catalog, sections };
    },
    async game(id: string) {
      return ready(() =>
        database.withConnection(async (connection) => {
          const [rows] = await connection.execute<Row[]>(
            `SELECT g.* FROM apimatic_games g WHERE g.currency = ? AND g.game_uuid = ? AND g.available = TRUE AND ${visibleGame}`,
            [config.APIMATIC_CURRENCY, id],
          );
          return rows[0] ? toGame(rows[0]) : null;
        }),
      );
    },
    async catalogStatus() {
      try {
        return await database.withConnection((connection) => readCatalogStatus(connection, config.APIMATIC_CURRENCY));
      } catch (error) { throw catalogFailure(error); }
    },
    async sync(fetchCatalog: () => Promise<ProviderGame[]>) {
      return synchronizeCatalog(database, config.APIMATIC_CURRENCY, fetchCatalog);
    },
    async disableGame(id: string) {
      await ready(() =>
        database.withConnection(async (connection) => {
          await connection.execute(
            "UPDATE apimatic_games SET available = FALSE WHERE currency = ? AND game_uuid = ?",
            [config.APIMATIC_CURRENCY, id],
          );
        }),
      );
    },
    async claimLaunch(
      playerId: string,
      gameId: string,
      requestId: string,
      mode: string,
    ) {
      return ready(() =>
        database.transaction(async (connection) => {
          const [players] = await connection.execute<Row[]>(
            "SELECT status FROM players WHERE id = ? FOR UPDATE",
            [playerId],
          );
          if (players[0]?.status !== "active")
            throw new AuthError(
              403,
              "PLAYER_BLOCKED",
              "This account cannot launch games.",
            );
          const [games] = await connection.execute<Row[]>(
            `SELECT g.game_uuid FROM apimatic_games g WHERE g.currency=? AND g.game_uuid=? AND g.available=TRUE AND ${visibleGame} FOR UPDATE`,
            [config.APIMATIC_CURRENCY, gameId],
          );
          if (!games[0]) throw new AuthError(404, "GAME_NOT_FOUND", "This game is no longer available.");
          const [existing] = await connection.execute<Row[]>(
            "SELECT id FROM apimatic_launches WHERE player_id = ? AND request_id = ?",
            [playerId, requestId],
          );
          if (existing[0])
            throw new AuthError(
              409,
              "LAUNCH_ALREADY_REQUESTED",
              "This launch was already requested. Return to the game and start a new session if needed.",
            );
          const initial = parseAmount(
            config.APIMATIC_TEST_CREDITS,
            config.APIMATIC_CURRENCY_DECIMALS,
            true,
          ).toString();
          await connection.execute(
            `INSERT IGNORE INTO apimatic_sandbox_wallets (player_id,currency,decimals,balance_units,initial_units) VALUES (?,?,?,?,?)`,
            [
              playerId,
              config.APIMATIC_CURRENCY,
              config.APIMATIC_CURRENCY_DECIMALS,
              initial,
              initial,
            ],
          );
          const wallet = await walletTransaction(connection, playerId).wallet(
            config.APIMATIC_CURRENCY,
          );
          if (wallet.decimals !== config.APIMATIC_CURRENCY_DECIMALS)
            throw new AuthError(
              503,
              "CURRENCY_PRECISION_CHANGED",
              "The test wallet currency configuration needs review.",
            );
          const id = randomUUID();
          await connection.execute(
            "INSERT INTO apimatic_launches (id,player_id,request_id,game_uuid,currency,mode) VALUES (?,?,?,?,?,?)",
            [id, playerId, requestId, gameId, config.APIMATIC_CURRENCY, mode],
          );
          return id;
        }),
      );
    },
    async completeLaunch(id: string, sessionId: string) {
      await ready(() =>
        database.transaction(async (connection) => {
          await lockLaunchOwner(connection, id);
          const [result] = await connection.execute<ResultSetHeader>(
            "UPDATE apimatic_launches SET status='ready',vendor_session_id=?,session_hash=? WHERE id=? AND status='pending'",
            [sessionId, hash(sessionId), id],
          );
          if (result.affectedRows !== 1)
            throw new AuthError(409, "LAUNCH_NOT_PENDING", "This game launch is no longer pending.");
        }),
      );
    },
    async failLaunch(id: string, code: string) {
      await ready(() =>
        database.transaction(async (connection) => {
          await lockLaunchOwner(connection, id);
          await connection.execute(
            "UPDATE apimatic_launches SET status='failed',error_code=? WHERE id=? AND status='pending'",
            [code.slice(0, 80), id],
          );
        }),
      );
    },
    async wallet(playerId: string) {
      return ready(() =>
        database.withConnection(async (connection) => {
          const [rows] = await connection.execute<Row[]>(
            "SELECT * FROM apimatic_sandbox_wallets WHERE player_id = ? AND currency = ?",
            [playerId, config.APIMATIC_CURRENCY],
          );
          const wallet = rows[0];
          const [events] = await connection.execute<Row[]>(
            `SELECT l.action,COALESCE(m.delta_units,l.delta_units) AS delta_units,l.reversed,l.error_code,l.created_at
          FROM apimatic_sandbox_ledger l LEFT JOIN apimatic_sandbox_movements m ON m.event_key=l.event_key AND m.currency=?
          WHERE l.player_id=? AND (l.currency=? OR m.currency=?) ORDER BY l.created_at DESC LIMIT 20`,
            [
              config.APIMATIC_CURRENCY,
              playerId,
              config.APIMATIC_CURRENCY,
              config.APIMATIC_CURRENCY,
            ],
          );
          const decimals =
            wallet?.decimals ?? config.APIMATIC_CURRENCY_DECIMALS;
          return {
            currency: config.APIMATIC_CURRENCY,
            balance: formatAmount(BigInt(wallet?.balance_units ?? 0), decimals),
            initialized: !!wallet,
            initialCredits: formatAmount(
              parseAmount(
                config.APIMATIC_TEST_CREDITS,
                config.APIMATIC_CURRENCY_DECIMALS,
                true,
              ),
              config.APIMATIC_CURRENCY_DECIMALS,
            ),
            transactions: events.map((event) => ({
              action: event.action,
              amount: formatAmount(BigInt(event.delta_units), decimals),
              reversed: !!event.reversed,
              errorCode: event.error_code,
              createdAt: event.created_at,
            })),
          };
        }),
      );
    },
    async postback(body: Postback, nonceHash: string) {
      return ready(() =>
        database.transaction(async (connection) => {
          const [players] = await connection.execute<Row[]>(
            "SELECT status FROM players WHERE id = ? FOR UPDATE",
            [body.player_id],
          );
          if (!players[0]) throw new WalletError("PLAYER_NOT_FOUND");
          const context = await resolveCallbackSession(body, players[0].status === "active", config.APIMATIC_CURRENCY, {
            async bySession(sessionId) {
              const [sessions] = await connection.execute<Row[]>(
                "SELECT id,player_id,game_uuid,currency,status,vendor_session_id FROM apimatic_launches WHERE session_hash=?",
                [hash(sessionId)],
              );
              return sessions[0] ? toCallbackLaunch(sessions[0]) : null;
            },
            async pending(callback) {
              const [pending] = await connection.execute<Row[]>(
                `SELECT id,player_id,game_uuid,currency,status,vendor_session_id,
                  TIMESTAMPDIFF(MICROSECOND,created_at,UTC_TIMESTAMP(3)) AS age_us
                FROM apimatic_launches
                WHERE player_id=? AND game_uuid=? AND currency=? AND status='pending'
                  AND vendor_session_id IS NULL AND session_hash IS NULL
                ORDER BY created_at DESC,id LIMIT 2`,
                [callback.player_id, callback.game_uuid, callback.currency],
              );
              return pending.map((row) => ({ ...toCallbackLaunch(row), ageMs: Number(row.age_us) / 1000 }));
            },
          });
          const identifiers = [
            body.transaction_id,
            body.round_id,
            ...("bet_transaction_id" in body ? [body.bet_transaction_id] : []),
            ...("rollback_transactions" in body
              ? body.rollback_transactions.map((item) => item.transaction_id)
              : []),
          ];
          if (identifiers.some((value) => value && !value.endsWith("@sbx")))
            throw new WalletError("WRONG_ENVIRONMENT");
          // Only lock this nonce on the callback path. Bulk expiry cleanup belongs in maintenance.
          await connection.execute(
            "DELETE FROM apimatic_callback_nonces WHERE nonce_hash = ? AND expires_at <= UTC_TIMESTAMP(3)",
            [nonceHash],
          );
          try {
            await connection.execute(
              "INSERT INTO apimatic_callback_nonces (nonce_hash,expires_at) VALUES (?,?)",
              [nonceHash, new Date(Date.now() + 600000)],
            );
          } catch (error) {
            if (
              error &&
              typeof error === "object" &&
              "code" in error &&
              error.code === "ER_DUP_ENTRY"
            )
              throw new WalletError("REPLAY_DETECTED");
            throw error;
          }
          const result = await applyPostback(
            walletTransaction(
              connection,
              body.player_id,
              eventKey(body.action, body.transaction_id),
            ),
            body,
            players[0].status === "active",
          );
          await connection.execute(
            "DELETE FROM apimatic_callback_issues WHERE event_key = ?",
            [issueKey(body)],
          );
          return { ...result, earlyBalanceLaunchId: context.earlyBalance ? context.launchId : undefined };
        }),
      );
    },
    async issue(body: Postback, reason: string) {
      await ready(() =>
        database.withConnection(async (connection) => {
          await connection.execute(
            `INSERT INTO apimatic_callback_issues (event_key,reason,payload) VALUES (?,?,?)
          ON DUPLICATE KEY UPDATE reason=VALUES(reason),attempts=attempts+1,last_seen_at=UTC_TIMESTAMP(3)`,
            [issueKey(body), reason.slice(0, 80), JSON.stringify(body)],
          );
        }),
      );
    },
  };
}
export type GamingStore = ReturnType<typeof createGamingStore>;

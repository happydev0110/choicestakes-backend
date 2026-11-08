import { createHash, randomUUID } from "node:crypto";
import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import type { Config } from "../../config/env.js";
import type { Database } from "../../database/mysql.js";
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
    async catalog(page: number, search: string, provider: string) {
      return ready(() =>
        database.withConnection(async (connection) => {
          const pattern = "%" + search.replace(/[=%_]/g, "=$&") + "%";
          const where =
            "currency = ? AND available = TRUE AND (name LIKE ? ESCAPE '=' OR provider LIKE ? ESCAPE '=') AND (? = '' OR provider = ?)";
          const params = [
            config.APIMATIC_CURRENCY,
            pattern,
            pattern,
            provider,
            provider,
          ];
          const [rows] = await connection.query<Row[]>(
            `SELECT * FROM apimatic_games WHERE ${where} ORDER BY provider, name, game_uuid LIMIT 28 OFFSET ?`,
            [...params, (page - 1) * 28],
          );
          const [counts] = await connection.execute<Row[]>(
            `SELECT COUNT(*) AS total, MAX(synced_at) AS synced_at FROM apimatic_games WHERE ${where}`,
            params,
          );
          const [providers] = await connection.execute<Row[]>(
            "SELECT DISTINCT provider FROM apimatic_games WHERE currency = ? AND available = TRUE ORDER BY provider",
            [config.APIMATIC_CURRENCY],
          );
          return {
            games: rows.map(toGame),
            total: Number(counts[0]?.total ?? 0),
            page,
            perPage: 28,
            providers: providers.map((row) => String(row.provider)),
            syncedAt: counts[0]?.synced_at ?? null,
          };
        }),
      );
    },
    async game(id: string) {
      return ready(() =>
        database.withConnection(async (connection) => {
          const [rows] = await connection.execute<Row[]>(
            "SELECT * FROM apimatic_games WHERE currency = ? AND game_uuid = ? AND available = TRUE",
            [config.APIMATIC_CURRENCY, id],
          );
          return rows[0] ? toGame(rows[0]) : null;
        }),
      );
    },
    async sync(fetchCatalog: () => Promise<ProviderGame[]>) {
      return ready(() =>
        database.withConnection(async (connection) => {
          const lock =
            "apimatic_sync_" + hash(config.APIMATIC_CURRENCY).slice(0, 20);
          const [locks] = await connection.execute<Row[]>(
            "SELECT GET_LOCK(?, 0) AS acquired",
            [lock],
          );
          if (locks[0]?.acquired !== 1)
            throw new Error("A catalogue sync is already running.");
          try {
            // Do not disable any games until every upstream page has been successfully validated.
            const games = await fetchCatalog();
            const generation = randomUUID();
            await connection.beginTransaction();
            try {
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
                    config.APIMATIC_CURRENCY,
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
                "UPDATE apimatic_games SET available = FALSE WHERE currency = ? AND sync_generation <> ?",
                [config.APIMATIC_CURRENCY, generation],
              );
              await connection.commit();
              return games.length;
            } catch (error) {
              await connection.rollback();
              throw error;
            }
          } finally {
            await connection.execute("SELECT RELEASE_LOCK(?)", [lock]);
          }
        }),
      );
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
        database.withConnection(async (connection) => {
          await connection.execute(
            "UPDATE apimatic_launches SET status='ready',vendor_session_id=?,session_hash=? WHERE id=? AND status='pending'",
            [sessionId, hash(sessionId), id],
          );
        }),
      );
    },
    async failLaunch(id: string, code: string) {
      await ready(() =>
        database.withConnection(async (connection) => {
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
          const [sessions] = await connection.execute<Row[]>(
            "SELECT * FROM apimatic_launches WHERE session_hash = ? AND status = ?",
            [hash(body.session_id), "ready"],
          );
          const session = sessions[0];
          if (
            !session ||
            session.vendor_session_id !== body.session_id ||
            session.player_id !== body.player_id ||
            (body.game_uuid && session.game_uuid !== body.game_uuid) ||
            (!["refund", "rollback"].includes(body.action) &&
              session.currency !== body.currency)
          )
            throw new WalletError("SESSION_NOT_FOUND");
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
          return result;
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

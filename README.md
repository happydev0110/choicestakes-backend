# Choicestakes backend

Node.js, TypeScript, Fastify and MySQL API for `../choicestacks-portal`. Requires Node.js 22.12 or newer. Includes player registration, login, durable sessions, and an API-MATIC sandbox catalog, game launch flow and test-credit wallet. Provider credentials and a public callback URL are required to activate games; payments and production gaming are not enabled.

## Configure your existing MySQL server

Keep credentials in the backend `.env`. Do not overwrite it when repeating setup.

```powershell
cd E:\Web\CP\_dev\choicestacks-backend
npm install
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
```

Set `DB_ENABLED=true` and fill `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_DATABASE`, `MYSQL_USER`, and `MYSQL_PASSWORD` for your existing server. The selected database must already exist. Use a dedicated application database; migrations create `schema_migrations`, `players`, `player_sessions`, and `player_auth_attempts`. If these names already exist from another application, choose a separate database before migrating. The migration account needs CREATE and REFERENCES permissions; the runtime account needs SELECT, INSERT, UPDATE and DELETE on the application tables.

```powershell
npm run db:check
npm run db:migrate
npm run db:auth:test
npm run dev
```

`db:auth:test` uses the configured development database, creates a unique synthetic player, exercises real persistence across two app instances, and removes only its own records afterward. It refuses production mode. Migrations are versioned and checksum-checked; MySQL DDL auto-commits and this initial migration can resume after interruption.

The API listens on `http://127.0.0.1:4000`. `DB_ENABLED=false` allows the HTTP process to start, but registration and login return 503; accounts never fall back to temporary memory. Restart the backend after editing `.env`. Use `MYSQL_SSL=true` for a remote TLS connection, with `MYSQL_SSL_CA` if your provider requires a CA file. Certificate verification stays enabled.

## Connect the portal

Start `../choicestacks-portal` on port 3000. Its server-only `BACKEND_URL` defaults to `http://127.0.0.1:4000`. Browsers call the portal's `/api/player/*` routes; Next.js forwards only the four allowed auth actions and the session cookie to this API. The backend can remain bound to loopback. Do not put database credentials in the frontend or `NEXT_PUBLIC_*` variables.

Set `CORS_ORIGINS` to exact portal origins, without trailing slashes. The defaults include `http://198.18.1.255:3000`. Auth POST requests require both an approved Origin and `X-Requested-With: choicestakes`; the portal forwards the browser's values rather than manufacturing them. Direct cross-origin browser cookie requests are not used.

| Backend endpoint | Portal endpoint | Purpose |
| --- | --- | --- |
| `POST /api/v1/auth/register` | `/api/player/register` | Create player and session |
| `POST /api/v1/auth/login` | `/api/player/login` | Verify password and rotate current session |
| `GET /api/v1/auth/me` | `/api/player/me` | Return authenticated player |
| `POST /api/v1/auth/logout` | `/api/player/logout` | Revoke current session and clear cookie |
| `GET /health/live` | — | HTTP process liveness |
| `GET /health/ready` | — | MySQL connection readiness |
| `GET /api/v1/` | — | Service name and API version |

Registration accepts `displayName`, `email`, `password`, `confirmPassword`, and `acceptTerms: true`. Names are 2–30 characters; passwords are 12–128 characters. Emails are trimmed/lowercased and unique in MySQL. Login accepts `email` and `password`. Responses expose only player ID, email, display name, and email verification status. Successful registration returns 201 and automatically signs in. Other actions return 200. Validation, incorrect credentials, duplicate registration, throttling and unavailable storage return 400, 401, 409, 429 and 503 respectively.

## Authentication behavior

- Passwords use salted Node.js scrypt (`N=65536`, `r=8`, `p=2`), with bounded concurrent hashing. No plaintext passwords are stored or logged.
- Sessions use random 256-bit tokens. Only SHA-256 token hashes are stored in MySQL. The cookie is HttpOnly, SameSite=Lax and host-only. Production adds Secure and the `__Host-` prefix; HTTPS is required.
- `SESSION_TTL_HOURS=24` controls absolute expiry; `SESSION_IDLE_MINUTES=60` controls inactivity expiry. Session checks update activity. Logout deletes the database session; disabled players cannot use existing sessions. A new login replaces the session supplied by that browser, while other devices remain signed in.
- Origin/custom-header checks protect authentication POSTs from CSRF. Authentication responses are not cached. Unexpected errors return generic JSON with a correlation ID; diagnostics stay in server logs.
- A durable account throttle allows 10 login attempts per email per 15-minute bucket. Process-local network limits allow 20 registrations and 100 logins per 15 minutes. Because the current portal proxy shares its backend IP, these network limits are shared across portal users. Configure a trusted proxy/client-IP strategy and shared network limiter when deploying at scale; do not blindly trust incoming `X-Forwarded-For` headers.
- Registration records the terms version and adult declaration. It does not verify age, identity or email ownership. Email verification, password reset, password changes, profile edits and 2FA are not implemented. The sandbox wallet uses MySQL; other account wallet/payment screens remain sample content.

Readiness checks connectivity, not the presence of migrated tables. Run migrations before accepting player traffic. Expired sessions are rejected immediately. Periodically prune `player_sessions` where `expires_at <= UTC_TIMESTAMP(3)` and `player_auth_attempts` where `bucket < FLOOR(UNIX_TIMESTAMP() / 900) - 1`; this maintenance is not scheduled by the app.

## Commands and deployment

| Command | Purpose |
| --- | --- |
| `npm run dev` | Run TypeScript with source watching |
| `npm run typecheck` | Check source and tests |
| `npm test` | API, auth, configuration and transaction tests using test doubles |
| `npm run db:check` | Check real configured MySQL connectivity |
| `npm run db:migrate` | Apply schema migrations |
| `npm run db:auth:test` | Check auth against real development MySQL, then clean up |
| `npm run db:games:test` | Check sandbox wallet transactions against development MySQL, then clean up |
| `npm run games:check` | Verify sandbox credentials and currency access with one read-only catalog request |
| `npm run games:status` | Inspect MySQL catalog state, total, sync timestamps and safe failure code |
| `npm run games:categories:export -- ./game-categories.json` | Export available games and existing category assignments for manual review |
| `npm run games:sync` | Synchronize the enabled sandbox game catalog |
| `npm run games:sync:watch` | Optional separate worker; uses APIMATIC_SYNC_INTERVAL_MINUTES |
| `npm run build` | Compile to `dist/` |
| `npm start` | Run the compiled API |

For deployment, build first, migrate, set `NODE_ENV=production`, an explicit HTTPS `CORS_ORIGINS`, and MySQL settings. Production startup requires a successful database connectivity check. Put Next.js behind HTTPS and restrict backend access to the portal server. SIGINT/SIGTERM close the server and pool. Sessions are durable across API restarts.

`src/database/mysql.ts` provides parameterized connection and transaction helpers. Transactions commit or roll back on one connection and always release it; failed rollbacks destroy the connection. DECIMAL and BIGINT stay strings to preserve precision. Sandbox wallet calculations use integer minor units.

Crypto payments and production gambling are not enabled. The sandbox game integration below is ready for provider configuration.


## API-MATIC sandbox setup

The integration always calls https://sandbox-api.api-matic.com. There is no production-host switch. Leave APIMATIC_ENABLED=false until the following backend .env fields are ready:

```dotenv
APIMATIC_ENABLED=false
APIMATIC_API_KEY=
APIMATIC_SECRET_KEY=
APIMATIC_CALLBACK_URL=https://api.yourdomain.com/api/v1/provider/apimatic/sandbox
APIMATIC_CURRENCY=EUR
APIMATIC_CURRENCY_DECIMALS=2
APIMATIC_TEST_CREDITS=1000
```

Copy the sandbox API key exactly as issued and its matching 64-character hexadecimal secret from Profile → Security. Keys are opaque: no particular key prefix is required, and you must not add one. The sandbox host authenticates the credentials; this application always calls the sandbox host and requires sandbox launch responses. EUR is an example: choose an enabled currency with its correct precision (2 or 3). Credits are allocated once per player/currency on the first launch attempt. There is no player-accessible refill or withdrawal endpoint.

You can test the keys and import games before a callback URL exists, while keeping `APIMATIC_ENABLED=false`:

```powershell
npm run games:check
npm run games:sync
```

`games:check` makes one signed GET to the sandbox catalog and prints the available game count. It does not launch a game, change a balance, or print credentials. Known provider failures include a safe error code and a setup hint (invalid key/signature, clock mismatch, currency access, rate limiting). `games:sync` needs MySQL and imports every page. It can run while gameplay is disabled. `/provider-games`, `/casino`, and `/providers` then show the imported collection, with game launches still blocked on the server. `configured` in the catalog response means catalog credentials are present; the separate `launchEnabled` flag controls the play UI.

Set the same dedicated sandbox callback URL in the provider's Currency & Games settings. The .env field does not configure their back office automatically. The URL must reach the Node.js callback over public HTTPS; localhost/private IPs cannot receive provider calls. Preserve the exact path and raw request bytes through your reverse proxy or development tunnel, and avoid redirects. Set a separate sandbox callback explicitly: the provider can otherwise fall back to its production callback setting.

After configuring the fields, set APIMATIC_ENABLED=true, restart the API, and run:

```powershell
npm run db:migrate
npm run games:sync
# Inspect the imported catalog:
npm run games:status
```

After migration `004_catalog_sync_status`, the HTTP backend synchronizes on startup and every 15 minutes by default (`APIMATIC_SYNC_ENABLED=true`, `APIMATIC_SYNC_INTERVAL_MINUTES=15`). This also works while `APIMATIC_ENABLED=false`; catalog imports do not need a callback. Each run reads every catalog page before updating MySQL. Failed/incomplete runs retain existing games. Successful runs disable missing games, including a verified zero-game response. Status and safe error codes are saved per currency. A MySQL advisory lock prevents overlapping syncs. To use a separate worker instead, disable the built-in worker and run `npm run games:sync:watch`. Only provider-hosted artwork from https://static.api-matic.com is accepted; missing artwork uses a placeholder.

The portal uses the synchronized catalog across home, Casino, Search, manual category pages, provider pages, public game details, and browser favorites. Cards use provider UUIDs; retired sample-title URLs return 404. See [provider catalog setup and manual classification](docs/provider-catalog.md) for migration, sync, deployment, and category commands. Authenticated `/play/{uuid}` offers sandbox play with test credits after callback configuration; it does not enable real-money play.

| Endpoint | Purpose |
| --- | --- |
| GET /api/v1/gaming/games | MySQL catalog; page, search, provider, category, sort and UUID filters |
| GET /api/v1/gaming/lobby | Casino preview rows, reviewed category games and complete category counts |
| GET /api/v1/gaming/games/:uuid | One available game |
| POST /api/v1/gaming/games/:uuid/launch | Authenticated/CSRF-checked launch with requestId UUID and mode real/demo |
| GET /api/v1/gaming/wallet | Authenticated sandbox balance and recent activity |
| POST /api/v1/provider/apimatic/sandbox | Signed server-to-server wallet callbacks |

Browser traffic goes through the portal's /api/gaming/* proxy. Provider credentials stay server-side; launch requests derive player_id from authentication. The returned vendor session ID is stored before returning the play URL. Play URLs are held only in browser memory. Launch request IDs prevent duplicate requests. Launches are never automatically retried after timeouts, because a provider session may already exist. Provider errors indicating removed/revoked games disable those catalog entries until the next sync.

## Sandbox wallet processing and limits

Callbacks verify HMAC-SHA256 over raw bytes before parsing, a five-minute timestamp window, and durable nonce uniqueness. Secrets are hex-decoded. Published signing vectors are covered by tests. Transactions require stored, confirmed sandbox sessions with matching player/game identity; complete transaction/round/reference identifiers, including vendor prefixes and @sbx suffixes, are retained.

Some vendors request a balance before returning the launch response. A signed `balance`
callback for an unknown session may read the existing wallet only when exactly one
unbound pending launch matches the active player, non-empty game UUID and configured
currency, and was created within the last 30 seconds. MySQL supplies the launch age.
Expired, failed, ambiguous or mismatched launches cannot use this path. The callback
does not bind the session, create a wallet, or alter a balance. Only the successful
provider response binds `vendor_session_id` and marks the launch ready. Bets, wins,
refunds and rollbacks still require the confirmed session. Launch completion/failure
and callbacks share the player-row lock, and no database lock spans the provider call.

For deployment of this callback fix, build and restart the backend after copying all
changed source files, including `src/modules/gaming/callback-session.ts`. No additional
migration or environment variable is needed for the callback fix itself. Existing
catalog/visibility migrations must already be applied. Start a new game launch after
deployment; failed sessions are not reopened automatically.

Diagnostics now include `Sandbox game launch pending`, `Sandbox balance answered during
pending launch`, and `Sandbox game launch ready`, correlated by `launchId`. Callback
warnings include game UUID, currency and a hash reference for the session rather than
its raw token. `SESSION_PLAYER_MISMATCH`, `SESSION_GAME_MISMATCH`,
`SESSION_CURRENCY_MISMATCH`, `SESSION_NOT_READY`, `PENDING_LAUNCH_EXPIRED` and
`PENDING_LAUNCH_AMBIGUOUS` distinguish different failures. `SESSION_NOT_FOUND` means no
known session or eligible pending launch was found; check that launch and callback
processes use the same database, and correlate the callback with its own game launch.
Launch records retain the specific safe provider error, such as `VENDOR_ERROR`, while
player-facing responses may still use the generic `PROVIDER_UNAVAILABLE`.

The handler implements balance, bet, win, refund and rollback. MySQL transactions lock the player to serialize balance changes across currencies. Integer minor units and DECIMAL storage avoid floating-point arithmetic. Responses emit exact decimal JSON numbers as required by the provider. Identity is action plus the full transaction ID; semantic fingerprints allow reordered JSON but reject conflicting retries. Accepted duplicates return the current balance without moving credits again; refused bets remain refused.

Refunds validate the original bet and can return a partial amount up to its recorded stake. A refunded bet cannot be returned again by another refund/rollback. Rollbacks use recorded changes, never the provider's stated reversal amounts. Cancellation tombstones suppress originals that arrive later. Reversing a win/refund can leave a negative test balance, which blocks future bets without refusing settlement. Settlement remains available after browser logout or player suspension. Historical currency precision is retained.

The sandbox wallet tables are separate from future payment tables. apimatic_sandbox_movements records actual callback balance changes independently of deduplication entries. Initial allocation plus movements must equal the wallet balance. Failed multi-item callbacks roll back balances, movements and nonce changes together.

Reconciliation: refunds without a bet reference require exactly one matching bet for that player/currency/game/round. Ambiguous refunds, unresolvable rollback references, conflicting transactions and unknown sessions/currencies are stored in apimatic_callback_issues and return non-success so the provider can retry. There is no admin reconciliation UI yet. Review these cases during vendor sandbox acceptance; retries are not a substitute for monitoring or reconciliation. The module supports one configured launch currency at a time, with historical currency wallets retained for settlement.

Periodically prune apimatic_callback_nonces rows whose expires_at <= UTC_TIMESTAMP(3); expired rows already permit reuse before pruning. Preserve financial test ledger, movement, launch and unresolved-issue records for reconciliation.

## Provider integration verification

```powershell
npm test
npm run db:games:test
```

The database check uses unique temporary players and a unique test currency, then removes only its own records. It simulates signed provider traffic locally without contacting API-MATIC. Checks include signature tampering, concurrent retries/bets, insufficient funds, refunds, rollback, out-of-order delivery, atomic failure, cross-instance deduplication, launch ownership, catalog recovery, and movement reconciliation.

The normal test suite includes a vendor that waits for a signed balance callback before
returning its launch response, as well as invalid signatures, replays, session mismatches,
expired/ambiguous launches and blocked early transactions. `db:games:test` also exercises
this sequence against MySQL with temporary fixture accounts and games.

Actual provider launches, iframe compatibility, public callback delivery and vendor acceptance still require your sandbox credentials and callback address. Production gaming and crypto deposit/withdrawal integration are separate future work.

Contract references: [API-MATIC reference](https://docs.api-matic.com/), [integration guide](https://docs.api-matic.com/guide).

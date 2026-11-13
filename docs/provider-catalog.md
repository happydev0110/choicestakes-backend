# Portal game catalog

The portal reads the MySQL catalog through its `/api/gaming/*` server proxy. Only API-MATIC games available to the configured sandbox key and currency are listed. Provider keys remain in the backend `.env`. Names, artwork URLs, provider codes, vendor codes, and UUIDs come from the provider. No guessed categories, popularity ranks, or win records are generated.

## Deploy and import

Deploy both the backend and portal changes. In the backend directory, with MySQL and sandbox credentials configured:

```sh
npm run db:migrate
npm run games:check
npm run games:sync
npm run games:status
npm run build
```

Restart the backend after deployment. Set the portal's **server-side** `BACKEND_URL=https://api.choicestakes.com`, then build and restart the portal. The backend's `CORS_ORIGINS` must include `https://choicestakes.com` for authenticated actions. Keep credentials out of `NEXT_PUBLIC_*` variables.

Apply migrations through `005_game_visibility` before restarting the updated backend. The backend imports immediately after its HTTP listener starts and refreshes every 15 minutes. It runs independently of visitor requests. Configuration:

```dotenv
APIMATIC_SYNC_ENABLED=true
APIMATIC_SYNC_INTERVAL_MINUTES=15
APIMATIC_ENABLED=false
```

Automatic imports require `DB_ENABLED=true`, a sandbox API key, and its matching 64-character hexadecimal secret. The key has no required prefix in this application; use the exact sandbox credentials. Catalog requests always use `https://sandbox-api.api-matic.com`. Set `APIMATIC_CURRENCY=USD` if USD is enabled for your sandbox account. A callback URL is not required for the catalog; `APIMATIC_ENABLED=false` keeps play disabled while callback setup is unfinished.

An incomplete or failed sync retains the previous catalog; a complete sync disables missing games. A successful empty response means the provider returned no available games for the configured currency. Check the currency, vendor, provider, and game switches in the provider dashboard. Manual category assignments survive refreshes. Nothing needs to be rebuilt when games or categories change.

For a separate worker process instead, set `APIMATIC_SYNC_ENABLED=false` on the HTTP backend and run `npm run games:sync:watch` under your process manager. It uses the same interval setting. The database lock prevents concurrent imports for a currency. Shut down the process gracefully to cancel outstanding provider requests before closing the database.

## Diagnose an empty collection

Run these commands from the **same backend deployment directory and environment** as the running API:

| Command | What it checks |
| --- | --- |
| `npm run games:check` | Read-only provider authentication and currency access; reports the provider's total |
| `npm run games:status` | Read-only MySQL import status, target database, total, timestamps, and safe last error code |
| `npm run games:sync` | Imports every provider page into that database immediately |

`games:status` distinguishes `not_synced`, `syncing`, `ready`, `empty`, `failed`, and `stale` (the previous collection remains available after a failed refresh). `lastSuccessAt` is retained even when a successful import returned zero games. The public API exposes only the collection state/count and attempt/success timestamps; operator error details remain in the CLI/logs. `configured:true` means credentials pass local validation, not that the provider accepted them. `launchEnabled` is independent of catalog availability.

If `games:check` reports games but the portal remains empty, compare `games:status` with `GET https://api.choicestakes.com/api/v1/gaming/games` and `GET https://choicestakes.com/api/gaming/games`. Confirm the API process uses the same MySQL database and currency as the import command, and the portal's server-side `BACKEND_URL` points to this API. Restart processes after environment changes. The player UI refreshes a first import every eight seconds for up to two minutes and provides a manual refresh button thereafter.

## Manual categories

Migration `003_game_categories` creates a separate assignment table. Provider sync preserves these assignments. Uncategorized games still appear in All Games, Search, their provider page, and favorites. Category pages remain empty until you assign games. A game may appear in multiple categories. New Games is an operator-curated category, not a provider release-date ranking.

Export the actual imported games as an editable review file:

```sh
npm run games:categories:export -- ./game-categories.json
```

The export includes every available game UUID, name, provider, vendor and existing assignments. It never invents tags and refuses to overwrite an existing file. Edit only each game's `categories` array after reviewing its type, then import using the command below. Use a new filename when exporting again. The exported `currency` must match the import environment. Names/providers/vendors are reference labels and cannot overwrite provider metadata.

Create a JSON file with this shape, replacing the example UUID with an actual `uuid` from `GET /api/v1/gaming/games` (use `search`, `provider`, and `page` to browse):

```json
{
  "assignments": [
    {
      "uuid": "00000000-0000-4000-8000-000000000001",
      "categories": ["slots", "new-games"]
    }
  ]
}
```

```sh
npm run games:classify -- ./game-categories.json
```

Allowed category names: `featured`, `new-games`, `slots`, `live`, `crash-instant`, `table-cards`, `lotto-scratch`, `roulette`, `poker`. Assign `featured` to an operator-selected game to show it in Featured Games; this is not a popularity ranking.

The command replaces assignments **only for the listed games**, for `APIMATIC_CURRENCY`. Use `"categories": []` to clear a game's assignments. Invalid IDs/categories abort the entire import. It does not alter names, artwork, provider fields, or other currencies.

The separate `choicestakes-admin` Games management page can also edit these categories
through its authenticated admin backend. Both backends must use the same database and
currency. Admin edits are audited; concurrent stale edits return a conflict.

## Portal visibility

Migration `005_game_visibility` adds `apimatic_game_settings`. Games are visible by
default; the admin can hide an imported game without modifying provider metadata.
Visibility and categories survive provider sync. The catalog, category rows, provider
counts, favorites, details and new launches exclude hidden games. Existing sessions
and settlement callbacks remain valid. Showing a game cannot override the provider's
unavailable status. Import status totals still describe the full provider import.

## Browsing behavior

- `/casino` is a dedicated server-rendered lobby with its banner, search, category links and horizontal rows. It never switches to another layout when credentials or data arrive. Loading skeletons and errors stay inside the lobby. `/all-games` is the full paginated collection.
- `GET /api/v1/gaming/lobby` (portal proxy `/api/gaming/lobby`) returns an All Games preview plus up to 16 available games per reviewed category and each category's full total. Category filtering happens in MySQL before taking the preview. Each View all link opens that category's complete paginated catalog. Empty category rows link to All Games; unassigned games are not duplicated into arbitrary categories.
- Initial lobby data is read server-side from `BACKEND_URL` with `no-store`. Background catalog synchronization runs separately. Never place API-MATIC secrets in the portal. Deploy/restart the backend **before** building/restarting the portal so its endpoints and visibility checks exist. Deploy a complete frontend build rather than mixing static HTML and JavaScript from different versions.

- Home, Casino, Search, categories, provider pages, game details, and favorites use the same catalog.
- The API returns 28 games per page, filtered before pagination. `search`, `provider`, `category`, `sort=provider|name|name-desc`, and `ids` (up to 100 comma-separated UUIDs) can be combined.
- Provider counts come from currently available games for the configured currency. The portal does not invent logos for studios.
- Details use `/games/{uuid}`; authenticated sandbox play uses `/play/{uuid}`. Retired sample title URLs return 404 instead of launching a guessed game.
- Favorites store up to 100 provider UUIDs in this browser. Removed games are hidden. Old sample favorites are not mapped by name.
- Empty catalogs and service errors show honest empty/retry states, with no sample-game fallback. Wins and popularity sections require separate verified data before being shown again.

Validation: `npm run typecheck`, `npm test`, `npm run db:catalog:test` (migrated development DB only).

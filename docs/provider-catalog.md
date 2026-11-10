# Portal game catalog

The portal reads the MySQL catalog through its `/api/gaming/*` server proxy. Only API-MATIC games available to the configured sandbox key and currency are listed. Provider keys remain in the backend `.env`. Names, artwork URLs, provider codes, vendor codes, and UUIDs come from the provider. No guessed categories, popularity ranks, or win records are generated.

## Deploy and import

Deploy both the backend and portal changes. In the backend directory, with MySQL and sandbox credentials configured:

```sh
npm run db:migrate
npm run games:check
npm run games:sync
npm run build
```

Restart the backend after deployment. Set the portal's **server-side** `BACKEND_URL=https://api.choicestakes.com`, then build and restart the portal. The backend's `CORS_ORIGINS` must include `https://choicestakes.com` for authenticated actions. Keep credentials out of `NEXT_PUBLIC_*` variables.

Run `npm run games:sync:watch` under your process manager to refresh immediately and every 15 minutes. An incomplete sync retains the previous catalog; a complete sync disables unavailable games. Nothing needs to be rebuilt when games or categories change. `APIMATIC_ENABLED=false` allows catalog browsing and sync while gameplay/callback setup is unfinished.

## Manual categories

Migration `003_game_categories` creates a separate assignment table. Provider sync preserves these assignments. Uncategorized games still appear in All Games, Search, their provider page, and favorites. Category pages remain empty until you assign games. A game may appear in multiple categories. New Games is an operator-curated category, not a provider release-date ranking.

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

Allowed category names: `new-games`, `slots`, `live`, `crash-instant`, `table-cards`, `lotto-scratch`, `roulette`, `poker`.

The command replaces assignments **only for the listed games**, for `APIMATIC_CURRENCY`. Use `"categories": []` to clear a game's assignments. Invalid IDs/categories abort the entire import. It does not alter names, artwork, provider fields, or other currencies. There is no public category-editing API or admin UI yet.

## Browsing behavior

- Home, Casino, Search, categories, provider pages, game details, and favorites use the same catalog.
- The API returns 28 games per page, filtered before pagination. `search`, `provider`, `category`, `sort=provider|name|name-desc`, and `ids` (up to 100 comma-separated UUIDs) can be combined.
- Provider counts come from currently available games for the configured currency. The portal does not invent logos for studios.
- Details use `/games/{uuid}`; authenticated sandbox play uses `/play/{uuid}`. Retired sample title URLs return 404 instead of launching a guessed game.
- Favorites store up to 100 provider UUIDs in this browser. Removed games are hidden. Old sample favorites are not mapped by name.
- Empty catalogs and service errors show honest empty/retry states, with no sample-game fallback. Wins and popularity sections require separate verified data before being shown again.

Validation: `npm run typecheck`, `npm test`, `npm run db:catalog:test` (migrated development DB only).

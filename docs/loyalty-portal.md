# Portal loyalty page

The `/loyalty-tiers` page reads sandbox tier thresholds and player XP from the
same MySQL database used by **Admin → Loyalty XP**. There is no second copy of
the settings and no hardcoded XP fallback.

## Deployment

1. In `choicestakes-adminback`, run `npm run db:migrate` to apply the existing
   `004_loyalty_xp` migration if it has not been applied yet.
2. Ensure the player backend and admin backend use the same database. The player
   backend's MySQL user needs SELECT access to `loyalty_programs` and
   `loyalty_accounts` (database-wide SELECT already covers these tables).
3. Build and restart `choicestakes-backend`, then build and restart
   `choicestakes-portal`. The portal uses its existing `BACKEND_URL` setting.

No new migration or environment variable is required for this release. Missing
tables or invalid configuration produce an explicit unavailable state.

## Read-only API

- `GET /api/v1/loyalty/tiers`: public tier codes, minimum/maximum XP and settings revision.
- `GET /api/v1/loyalty/me`: the same thresholds plus the authenticated player's
  XP, current tier, next tier, remaining XP and percentage within the current tier.

The portal proxies these through `/api/loyalty/tiers` and `/api/loyalty/me`.
Personal XP always comes from the current player session. Query parameters,
other player IDs and write operations are not supported. All responses are
`no-store`; the API never returns admin identities or adjustment reasons.
An account without a loyalty record starts at 0 XP. A failed read is never
displayed as 0 XP.

The page refreshes when opened, when returning to its browser tab, or when the
player presses Refresh. It does not poll on a timer. Admin adjustments and tier
changes appear at the next refresh. Guest views show the tier catalog and a login
link that returns to the loyalty page.

Automatic wager-earned XP and cashback/reward payouts remain disabled. XP is
separate from the game wallet. Stage I/II subdivisions are not defined; the page
uses the six admin-managed tiers. The page is translated into all nine portal
languages, with numbers formatted for the selected locale.

Validation: `npm test` and `npm run build` in the player backend; `npm run build`
in the portal. The admin backend's `db:loyalty:test` also checks that its XP and
threshold edits are immediately visible through the player backend's store.

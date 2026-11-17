# Live wallet updates

The shared portal wallet refreshes after a `wallet.updated` notification, on page navigation, on returning to a visible tab, and after the stream reconnects. There is no scheduled balance polling. This updates the header and account wallet without reloading the Sports/game iframe or opening a new provider session.

## Deployment

Deploy the backend first, then the portal. No MySQL migration or provider dashboard change is required.

Backend:

```sh
npm ci
npm run build
pm2 restart backend --update-env
```

Portal (in its own directory):

```sh
npm ci
npm run build
# Restart the existing portal process with its actual PM2 process name.
```

Keep the portal's server-only `BACKEND_URL` pointing at the backend, for example `http://127.0.0.1:4000`. The browser connects to the portal using its existing HttpOnly session cookie; it never receives provider keys or a Redis URL.

### One backend process

Leave `WALLET_EVENTS_REDIS_URL` empty when exactly one backend process handles both callbacks and SSE connections. No additional service is needed. Run PM2 in fork mode with one instance. Node/PM2 cluster workers reject startup without Redis instead of silently missing notifications.

### Multiple workers or servers

Set the same private Redis connection and channel on every backend worker:

```dotenv
WALLET_EVENTS_REDIS_URL=redis://127.0.0.1:6379
WALLET_EVENTS_REDIS_CHANNEL=choicestakes:sandbox:wallet
```

Use an authenticated `rediss://` connection when Redis is remote. Keep its credentials in the backend environment. Choose a different channel for each deployment/environment; Redis Pub/Sub channels are not isolated by Redis database number. The configured Redis service must be reachable at startup. Redis carries only player-scoped invalidation messages; MySQL remains the balance source of truth.

### Nginx streaming

In the `choicestakes.com` server block, add an exact location before applying/reloading your configuration. Adapt the upstream port if needed, and preserve any site-wide authentication/security settings:

```nginx
location = /api/gaming/wallet/events {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_cache off;
    gzip off;
    proxy_read_timeout 75s;
    proxy_send_timeout 75s;
}
```

Run `sudo nginx -t` before reloading. Any additional reverse proxy/CDN must also pass SSE chunks through immediately and allow a persistent response. Use HTTP/2 between browser and edge when available, especially with multiple open tabs. A platform with a fixed short response-duration limit is unsuitable without a streaming-capable route.

## Behavior and recovery

- A signed callback updates balances and ledger rows atomically. Notifications are emitted only after commit and only if a balance changed; rejected/replayed/unchanged transactions do not emit updates. The first game launch also requests a refresh because it can initialize the wallet.
- Events contain no amounts, session tokens, or provider details. Player identity comes from the authenticated session, not a query parameter. The browser fetches the latest wallet snapshot using its normal authenticated API.
- The browser serializes/coalesces wallet reads during bursts, so older responses cannot overwrite newer snapshots.
- The server validates sessions without extending idle expiry. Heartbeat comments every 20 seconds keep the connection open; they do **not** fetch balances or trigger frontend wallet reads.
- Hidden tabs close their connection. Returning tabs reconnect and fetch current state. Network failures retry the connection with backoff. Logout/account changes close old connections and discard old requests.
- Redis interruptions and backend shutdown close streams. On reconnection the server sends `wallet.ready` after subscribing, and the browser fetches a fresh snapshot to cover missed events. Notifications are not a durable financial ledger; duplicate delivery is harmless and there is no replay of money operations.
- Failed notification delivery does not roll back a committed wallet transaction or fail the provider callback. The last fetched balance may be stale during an outage; the header's accessible label/title says live updates are reconnecting. Provider callback delays still delay the balance change itself.

## Verification

Backend `npm test` includes real local HTTP SSE tests using fake sessions and callbacks, plus wallet accounting tests. No provider call or database is needed. An optional multi-worker Redis test runs when `TEST_WALLET_REDIS_URL` points at a disposable test Redis instance; it uses a unique channel and performs no key writes.

Portal: `npm run test:wallet` checks event/reconnect lifecycle, no periodic refresh, request coalescing, account-switch cleanup, and proxy streaming/cancellation. `npm run build` validates the full portal.

After deployment, sign in and open Sports. In browser Network, `/api/gaming/wallet/events` should stay pending with `text/event-stream` and receive `wallet.ready`. An idle page should not issue a new wallet GET every 30 seconds. After a successful provider bet/settlement callback, `wallet.updated` should trigger a wallet GET without another launch POST. Returning to the tab or restoring connectivity should fetch a fresh balance.

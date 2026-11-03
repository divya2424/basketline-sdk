# @divya2424/basketline-sdk

Send ad and shopper events from your website to [Basketline](https://github.com/divya2424/basketline), and see impressions, clicks, click-to-basket, unique customers and sessions for every campaign on your Basketline dashboard.

- **Small:** about 6 KB minified, no dependencies.
- **Safe for your page:** it never throws into it. Problems go to `onError`.
- **Batched:** 20 events per request or every 2 s, and sent when the page is hidden, so nothing is lost on navigation.
- **Attribution included:** you send what happened (`click`, `add_to_cart`), and Basketline credits each add to cart to the shopper's latest ad click on that product within 7 days.
- **Your IDs:** send your own product and campaign IDs (SKUs, codes) or UUIDs.
- **A server side too:** `@divya2424/basketline-sdk/server` sends your sellers, products and campaigns from your backend (see [Your catalog and campaigns](#your-catalog-and-campaigns-server)).

## Install

The package is on GitHub Packages, which needs a token even to install it:

1. Create a GitHub personal access token (classic) with the `read:packages` scope.
2. Tell npm where the package lives, in an `.npmrc` next to your `package.json`:
   ```
   @divya2424:registry=https://npm.pkg.github.com
   //npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
   ```
3. Install it with the token in the environment (and the same in CI):
   ```bash
   export NODE_AUTH_TOKEN=<your token>
   npm install @divya2424/basketline-sdk
   ```

```js
import { createBasketline } from '@divya2424/basketline-sdk'
```

Or with a script tag, without a bundler: host `dist/basketline.global.js` from the package on your own site.

```html
<script src="/js/basketline.global.js"></script>
<script>
  const bl = Basketline.createBasketline({ apiUrl: 'https://api.example.com/api/v1', tenantId: 'YOUR-TENANT-ID' })
</script>
```

## Quick start

```js
const bl = createBasketline({
  apiUrl: 'https://api.example.com/api/v1',     // your Basketline API: the dashboard's setup code shows it
  tenantId: 'YOUR-TENANT-ID',                   // your tenant ID, from Basketline
})

// track(): what the shopper did with your ads and store.

// An ad's product was shown: one impression per product, with the store (seller) whose campaign it is.
bl.track('impression', { campaignId, productId, storeId: sellerId })

// The shopper clicked it, opening the product.
bl.track('click', { campaignId, productId, storeId: sellerId })

// The shopper added a product to the cart (anywhere on your site, any time in the next 7 days).
bl.track('add_to_cart', { productId, storeId: product.sellerId, quantity: 1 })

// Anything else you want to analyse later.
bl.track('cart_view', { pageName: 'cart' })

// identity(): sign-in activity.
bl.identity('login_click', { pageName: 'header' })
```

That's all a visitor needs. The SDK:
1. gives the browser a lasting visitor ID for your store;
2. gets a visitor token for it from Basketline;
3. sends the events with that token.

`bl.track(eventName, fields)` takes the interactions (`INTERACTION_EVENTS`):

| `eventName` | Required fields | Counts toward |
|---|---|---|
| `'impression'` | `campaignId` | impressions |
| `'click'` | `campaignId`; `productId` for click-to-basket | clicks, and the click an add to cart is credited to |
| `'add_to_cart'` | `productId`; `quantity` optional | click-to-basket |
| `home_view`, `campaign_navigation`, `product_impression`, `product_click`, `cart_view`, `cart_quantity_update`, `remove_from_cart` | none | stored for later analysis |

`bl.identity(eventName, fields?)` takes sign-in activity (`IDENTITY_EVENTS`): `login_click`, `signup_click`, `login` and `logout`. You rarely send the last two yourself: `identify()` and `reset()` do (see below).

Every event also takes `storeId` (the seller it's about: the seller of the ad's campaign, or of the product added to the cart; default the client's `storeId`), `pageName`, `featureName` and `properties`. In TypeScript, a missing required field, or an event sent through the wrong method, is a compile error.

**IDs** are your own (a SKU like `SKU-123/blue`, a campaign code like `diwali-2026`: letters, digits and `._:/-`, up to 128 characters) or UUIDs. Use the same IDs as in your catalog (see the server side). `track` and `identity` return the event's ID, or `null` if the event was invalid; the reason goes to `onError`. `properties` holds anything else useful. Keys that look like personal data (email, phone, address, names, card numbers, …) are dropped before sending.

`bl.sendEvent(eventName, fields)` from 0.2 still works for every event; it is deprecated in favour of `track` and `identity`.

## Signed-in shoppers

When a shopper signs in to your site, tell the SDK who they are. Their activity then counts as a registered customer's, across devices. Basketline never sees your users' passwords or personal data. Your **backend** vouches for the shopper with your **secret API key**:

```
 browser (SDK)                     your backend                         Basketline
 ─────────────                     ────────────                         ──────────
 bl.visitorId ───── sign-in ─────► POST /auth/shopper-token  ─────────► checks the API key
                                    Authorization: ApiKey bl_sk_…        maps your customer ID
                                    tenant_id: YOUR-TENANT-ID            to one Basketline user ID
                                    { customerId, visitorId }   ◄─────── { shopperToken, userId }
 bl.identify({ userId, getToken }) ◄── { userId, token }
```

**1. Your backend** gets a shopper token. Keep the API key on the server; never put it in the page.

```ts
// See examples/backend-token.ts for an Express handler.
const res = await fetch('https://api.example.com/api/v1/auth/shopper-token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', tenant_id: TENANT_ID, Authorization: `ApiKey ${process.env.BASKETLINE_API_KEY}` },
  body: JSON.stringify({ customerId: currentUser.id, visitorId: req.body.visitorId }),
})
const { shopperToken, userId } = await res.json()   // the token lasts 30 minutes
```

**2. The page** passes it to the SDK:

```js
const { userId } = await fetch('/api/basketline-token', { method: 'POST', body: JSON.stringify({ visitorId: bl.visitorId }) }).then((r) => r.json())
bl.identify({
  userId,
  // Called whenever the SDK needs a token: now, before it expires, and after a 401.
  getToken: () => fetch('/api/basketline-token', { method: 'POST' }).then((r) => r.json()).then((b) => b.token),
})

// On sign-out:
bl.reset()
```

`identify()` sends a `login` event, and `reset()` a `logout` event (as the shopper, before switching back to the visitor). The SDK remembers who signed in on this browser, so calling `identify()` on every page load sends `login` only once per sign-in.

**Why `visitorId`:** the first time a customer gets a token, Basketline gives them the browser's visitor ID. Their visits from before they signed in then count as the same person. Later calls return the same `userId`, whatever `visitorId` comes with them.

**API keys:** every store gets its first key when it's onboarded, shown once on the onboarding page. Campaign managers create and revoke keys in the dashboard, under **Integrate your site**. Or locally, with the CLI:

```bash
docker compose exec auth-service node services/auth-service/src/cli.ts create-api-key --tenant <tenant-id> --name 'Production web'
```

The key is shown once. `list-api-keys` and `revoke-api-key --prefix bl_sk_…` manage them. A shopper token can only send events; no other Basketline API accepts it.

## Your catalog and campaigns (server)

Your sellers (each one a store: Basketline reports per store), their products and campaigns, and the products added to each campaign go to Basketline with your API key, and to its data lake for later analysis. Only your servers know them, so they send them. Never import this entry into a page.

```ts
import { createBasketlineServer } from '@divya2424/basketline-sdk/server'

const basketline = createBasketlineServer({
  apiUrl: 'https://api.example.com/api/v1',
  tenantId: 'YOUR-TENANT-ID',
  apiKey: process.env.BASKETLINE_API_KEY!,
})

// After each change in your systems (or all at once, to start): the record's full state.
await basketline.catalog.upsertSeller({ sellerId: 'acme', name: 'Acme Audio' })
await basketline.catalog.upsertProduct({ productId: 'SKU-123', sellerId: 'acme', name: 'Earbuds', category: 'Audio', price: 2999 })
await basketline.campaigns.upsert({ campaignId: 'diwali-2026', sellerId: 'acme', placement: 'spotlight', title: 'Diwali sale', status: 'active', productIds: ['SKU-123'] })

// Products added to a campaign, with the details they have there (they name the product in its results); and taken out again.
await basketline.campaigns.addProducts({ campaignId: 'diwali-2026', productId: 'SKU-123', sellerId: 'acme', productName: 'Earbuds', productPrice: 2999, category: 'Audio' })
await basketline.campaigns.removeProducts({ campaignId: 'diwali-2026', productId: 'SKU-123' })

await basketline.catalog.removeProduct('SKU-123')
await basketline.campaigns.remove('diwali-2026')

// A shopper's sign-in succeeded (stronger than the page's login event), and erasure requests.
await basketline.identity.identified({ userId, visitorId })
await basketline.identity.deleteUser(userId)

// A campaign's results per product, e.g. for the seller's portal: impressions, clicks, CTR, add-to-carts.
const results = await basketline.insights.campaignProducts({ campaignId, storeId: sellerId, from: '2026-10-01', to: '2026-11-01' })
```

- **Full state, newest wins:** send the whole record each time, with `updatedAt` (when it changed; default now). An update older than one Basketline already has is ignored, so retries and out-of-order sends are safe.
- **Stores are sellers:** a record's `storeId` defaults to its `sellerId`, so you rarely send it; a product without `sellerId` is your own (first-party).
- **Placements:** a campaign's `placement` is where your site shows it (e.g. `spotlight`, `deals`); it goes to the data lake with the campaign.
- **Results:** `insights.campaignProducts` takes Basketline's IDs (a UUID you sent is used as is); `from`/`to` are UTC days, default the last 30.
- **Arrays:** every method also takes an array; large ones go 500 per request.
- **Errors throw** (a `BasketlineError` with the status and the API's reasons), unlike the browser client: retry them from your job queue. A `401` gets a fresh token once and a `429`/`5xx` is retried once.
- **Auth:** the API key is exchanged for a 15-minute integration token, reused until shortly before it expires. Requires Node 18+ (global `fetch`) or a `fetch` option.

## Options

| Option | Default | |
|---|---|---|
| `apiUrl` | — | The Basketline API, as shown in the dashboard's setup code (**Integrate your site**); locally `http://localhost:8080/api/v1` |
| `tenantId` | — | Your tenant ID |
| `storeId` | — | The store (seller) for events sent without their own `storeId` (your own ID or a UUID); the dashboard splits every metric by store |
| `clientType` | `'web'` | `'web'` or `'mobile'`; the dashboard splits every metric by it |
| `batchSize` | `20` | Events per request (at most 100) |
| `flushAfterMs` | `2000` | How long the first queued event waits for others |
| `storage` | `localStorage` | Where the visitor ID is kept (`getItem`/`setItem`). Without storage, the ID lasts for the page |
| `onError` | `console.warn` | `(error: BasketlineError) => void`: invalid events, dropped properties, failed requests |
| `debug` | `false` | Logs every event and request |
| `fetch` | `globalThis.fetch` | For tests or unusual runtimes |

`bl.flush()` sends what's queued now and resolves when it's done. `bl.visitorId` is the browser's visitor ID for your store.

## Delivery

- **Retries:**
  - a `401` fetches a fresh token once;
  - a `429` or `5xx` is retried once, after `Retry-After`;
  - anything else goes to `onError`.
- **Order:** batches go out in order, so a shopper's events never overtake each other.
- **Across identities:** events queued before `identify()` or `reset()` go out under the identity they were tracked with.
- **Rate limits** (per IP, at the gateway):
  - 120 event requests a minute;
  - 10 visitor tokens a minute;
  - 300 events per sender a minute.
- **CORS:** the SDK's endpoints (`/auth/visitor`, `/analytics/events`) accept requests from any origin, so it works on your domain without setup.
- **Allowed websites:** once you list your sites in the Basketline dashboard (**Integrate your site → Allowed websites**, e.g. `https://shop.example`), pages on any other website can't send your store's events: requests get `403 ORIGIN_NOT_ALLOWED`, reported to `onError`. Add every address your shop runs on, including staging and `http://localhost:<port>` while developing. Your backend's calls and mobile apps send no browser origin and aren't affected.

## Develop and publish

```bash
pnpm install
pnpm test             # Vitest + jsdom
pnpm typecheck
pnpm build        # dist/: ESM, CommonJS (index and server), basketline.global.js (window.Basketline), .d.ts
npm pack             # divya2424-basketline-sdk-0.3.0.tgz, to try in another project
```

**Publishing:** bump `version` in `package.json`, push, and create a GitHub release `vX.Y.Z`. The `publish` workflow runs the typecheck, tests and build, then publishes to GitHub Packages. `ci` runs the same checks on every push and pull request.

**Keeping in step with the API:**
- the event names must match the API's. Basketline checks them against its contracts (`frontend/src/analytics/sdkContract.test.js` in [basketline](https://github.com/divya2424/basketline)), so a release with a new event name needs the API to accept it first;
- Basketline's own storefront sends its events through this package, so its tests exercise it too.

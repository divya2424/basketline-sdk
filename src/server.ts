/**
 * @divya2424/basketline-sdk/server: for your backend, never a browser (it holds
 * your API key). Sends what only your servers know: your sellers, their products
 * and campaigns, the products you add to a campaign, and which shoppers signed in
 * or were erased.
 *
 *   const basketline = createBasketlineServer({ apiUrl, tenantId, apiKey: process.env.BASKETLINE_API_KEY })
 *   await basketline.catalog.upsertSeller({ sellerId: 'acme', name: 'Acme' })
 *   await basketline.catalog.upsertProduct({ productId: 'SKU-1', storeId: 'web', sellerId: 'acme', name: 'Earbuds', price: 2999 })
 *   await basketline.campaigns.upsert({ campaignId: 'diwali', storeId: 'web', sellerId: 'acme', title: 'Diwali', status: 'active', productIds: ['SKU-1'] })
 *   await basketline.campaigns.addProducts({ campaignId: 'diwali', productId: 'SKU-1', storeId: 'web', productName: 'Earbuds', productPrice: 2999 })
 *
 * Each update is the record's full state, with when it is from (updatedAt,
 * default now): the newest wins, so retries and out-of-order sends are safe.
 * IDs are yours (a SKU, a code) or UUIDs. Unlike the browser client, failures
 * throw, so your code can retry them.
 */
import { BasketlineError } from './client'

export interface BasketlineServerOptions {
  /** The Basketline API, e.g. "https://api.example.com/api/v1". */
  apiUrl: string
  /** Your tenant ID (UUID), from Basketline. */
  tenantId: string
  /** Your API key (bl_sk_…), from the dashboard. */
  apiKey: string
  /** The fetch to use (default globalThis.fetch). */
  fetch?: typeof fetch
}

/** When the state is from (ISO 8601; default now): an older update than one already received is ignored. */
interface Versioned {
  updatedAt?: string | Date
}

export interface Seller extends Versioned {
  sellerId: string
  name: string
}

export interface Product extends Versioned {
  productId: string
  /** The store it's sold in (your own ID or a UUID). */
  storeId?: string
  /** Who sells it; without one, it is your own (first-party). */
  sellerId?: string
  name: string
  category?: string | null
  price?: number | null
  isActive?: boolean
}

export interface Campaign extends Versioned {
  campaignId: string
  /** The store it runs in (your own ID or a UUID). */
  storeId?: string
  /** Who runs it: its products must be this seller's. */
  sellerId: string
  title: string
  status: 'draft' | 'active' | 'paused' | 'completed'
  startTime?: string | null
  endTime?: string | null
  archived?: boolean
  productIds: string[]
}

/** A product added to a campaign, with the details it has there. */
export interface CampaignProduct extends Versioned {
  campaignId: string
  productId: string
  storeId?: string
  sellerId?: string
  productName: string
  productPrice?: number | null
  category?: string | null
}

export interface Identified extends Versioned {
  /** The shopper's Basketline ID (POST /auth/shopper-token's userId). */
  userId: string
  /** The browser's visitor ID they signed in from (the SDK's bl.visitorId). */
  visitorId?: string
}

type Endpoint = 'catalog' | 'campaigns' | 'identity'
interface Update {
  eventName: string
  updatedAt: string
  data: Record<string, unknown>
}

/** Updates per request (the API's limit). */
const MAX_PER_REQUEST = 500
/** Integration tokens last 15 minutes; a new one is fetched a minute before. */
const RENEW_BEFORE_MS = 60_000

export function createBasketlineServer(options: BasketlineServerOptions) {
  const { tenantId, apiKey } = options
  const base = options.apiUrl.replace(/\/+$/, '')
  const doFetch: typeof fetch = (input, init) => (options.fetch ?? globalThis.fetch)(input, init)
  let token: { value: Promise<string>; renewAt: number } | undefined

  async function fetchToken(): Promise<string> {
    const res = await doFetch(`${base}/auth/integration-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', tenant_id: tenantId, Authorization: `ApiKey ${apiKey}` },
      body: '{}',
    })
    if (!res.ok) throw await apiError(res, 'could not get an integration token (check the API key and tenant ID)')
    const { integrationToken, expiresIn } = (await res.json()) as { integrationToken: string; expiresIn: number }
    token!.renewAt = Date.now() + expiresIn * 1000 - RENEW_BEFORE_MS
    return integrationToken
  }

  function integrationToken(fresh: boolean): Promise<string> {
    if (!token || fresh || token.renewAt <= Date.now()) {
      const entry: { value: Promise<string>; renewAt: number } = { value: Promise.resolve(''), renewAt: Infinity }
      token = entry
      entry.value = fetchToken()
      // A failed request is retried with the next call.
      entry.value.catch(() => token === entry && (token = undefined))
    }
    return token.value
  }

  /** One request: a 401 gets a fresh token once, a 429 or 5xx (or no network) one retry after a second. */
  async function post(endpoint: Endpoint, events: Update[]): Promise<void> {
    let res: Response | undefined
    let retried = false
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        res = await doFetch(`${base}/retail/${endpoint}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await integrationToken(res?.status === 401)}` },
          body: JSON.stringify({ events }),
        })
      } catch (cause) {
        if (cause instanceof BasketlineError || retried) throw cause instanceof BasketlineError ? cause : new BasketlineError(`${endpoint} not sent: network error`, { cause })
        retried = true
        await pause(1000)
        continue
      }
      if (res.ok) return
      if (res.status === 401 && attempt === 0) continue
      if ((res.status === 429 || res.status >= 500) && !retried) {
        retried = true
        await pause(1000)
        continue
      }
      break
    }
    throw await apiError(res!, `${events.length} ${endpoint} updates not sent`)
  }

  async function send(endpoint: Endpoint, events: Update[]): Promise<void> {
    for (let i = 0; i < events.length; i += MAX_PER_REQUEST) await post(endpoint, events.slice(i, i + MAX_PER_REQUEST))
  }

  /** One update per record; updatedAt goes on the update, the rest is its data. */
  const updates = <T extends object>(eventName: string, records: T | T[]): Update[] =>
    (Array.isArray(records) ? records : [records]).map((record) => {
      const { updatedAt, ...data } = record as T & Versioned
      return { eventName, updatedAt: (updatedAt === undefined ? new Date() : new Date(updatedAt)).toISOString(), data }
    })

  return {
    catalog: {
      upsertSeller: (sellers: Seller | Seller[]) => send('catalog', updates('seller_upserted', sellers)),
      upsertProduct: (products: Product | Product[]) => send('catalog', updates('product_upserted', products)),
      removeProduct: (productIds: string | string[]) => send('catalog', updates('product_removed', [productIds].flat().map((productId) => ({ productId })))),
    },
    campaigns: {
      upsert: (campaigns: Campaign | Campaign[]) => send('campaigns', updates('campaign_upserted', campaigns)),
      remove: (campaignIds: string | string[]) => send('campaigns', updates('campaign_removed', [campaignIds].flat().map((campaignId) => ({ campaignId })))),
      /** Products added to a campaign (campaign_product_added), each with its name, price and so on. */
      addProducts: (products: CampaignProduct | CampaignProduct[]) => send('campaigns', updates('campaign_product_added', products)),
      /** Products taken out of a campaign (campaign_product_removed). */
      removeProducts: (products: Pick<CampaignProduct, 'campaignId' | 'productId' | 'updatedAt'> | Pick<CampaignProduct, 'campaignId' | 'productId' | 'updatedAt'>[]) =>
        send('campaigns', updates('campaign_product_removed', products)),
    },
    identity: {
      /** A shopper signed in: their visitor activity and later events count as one customer. */
      identified: (shoppers: Identified | Identified[]) => send('identity', updates('user_identified', shoppers)),
      /** Erasure: Basketline deletes the shopper's events and stops counting them. */
      deleteUser: (userIds: string | string[]) => send('identity', updates('user_deleted', [userIds].flat().map((userId) => ({ userId })))),
    },
  }
}

export type BasketlineServer = ReturnType<typeof createBasketlineServer>
export { BasketlineError }

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function apiError(res: Response, message: string): Promise<BasketlineError> {
  let code: string | undefined
  let details: unknown
  try {
    const body = (await res.json()) as { error?: { code?: string; details?: unknown } }
    code = body.error?.code
    details = body.error?.details
  } catch {
    // Not JSON.
  }
  return new BasketlineError(`${message} (${res.status}${code ? ` ${code}` : ''})`, { status: res.status, code, cause: details })
}

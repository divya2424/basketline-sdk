import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBasketlineServer } from '../src/server'
import { TENANT } from './helpers'

const API = 'https://api.example.com/api/v1/'

afterEach(() => {
  vi.useRealTimers()
})

/** A fake Basketline API: integration tokens are integration-1, integration-2, …; retail calls get `status()` (202 by default). */
function fakeServerApi(status: () => number = () => 202) {
  const calls: { path: string; headers: Headers; body: any }[] = []
  let tokens = 0
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    calls.push({ path: url.pathname, headers: new Headers(init?.headers), body: init?.body ? JSON.parse(String(init.body)) : null })
    if (url.pathname.endsWith('/auth/integration-token')) {
      tokens += 1
      return Response.json({ integrationToken: `integration-${tokens}`, tokenType: 'Bearer', expiresIn: 900 }, { status: 201 })
    }
    const code = status()
    return Response.json(code < 300 ? { accepted: 1 } : { error: { code: 'VALIDATION_ERROR', details: ['bad'] } }, { status: code })
  })
  const retailCalls = () => calls.filter((call) => call.path.includes('/retail/'))
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls, retailCalls }
}

const server = (api = fakeServerApi()) => ({ api, basketline: createBasketlineServer({ apiUrl: API, tenantId: TENANT, apiKey: 'bl_sk_test', fetch: api.fetch }) })

describe('the server entry', () => {
  it('exchanges the API key for an integration token, reused until shortly before it expires', async () => {
    vi.useFakeTimers()
    const { api, basketline } = server()
    await basketline.catalog.upsertSeller({ sellerId: 'acme', name: 'Acme' })
    await basketline.catalog.removeProduct('SKU-1')
    const tokenCall = api.calls[0]!
    expect(tokenCall.path).toBe('/api/v1/auth/integration-token')
    expect(tokenCall.headers.get('Authorization')).toBe('ApiKey bl_sk_test')
    expect(tokenCall.headers.get('tenant_id')).toBe(TENANT)
    expect(api.retailCalls().map((c) => c.headers.get('Authorization'))).toEqual(['Bearer integration-1', 'Bearer integration-1'])
    // 14 minutes on, within a minute of its 15: a new one.
    vi.setSystemTime(Date.now() + 14 * 60_000 + 1)
    await basketline.campaigns.remove('diwali')
    expect(api.retailCalls().at(-1)!.headers.get('Authorization')).toBe('Bearer integration-2')
  })

  it('sends each record as an update of its endpoint, with when it is from', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-31T10:00:00Z') })
    const { api, basketline } = server()
    await basketline.catalog.upsertProduct([
      { productId: 'SKU-1', sellerId: 'acme', name: 'Earbuds', price: 2999, updatedAt: new Date('2026-10-30T09:00:00Z') },
      { productId: 'SKU-2', name: 'Cable' },
    ])
    await basketline.campaigns.upsert({ campaignId: 'diwali', sellerId: 'acme', title: 'Diwali', status: 'active', productIds: ['SKU-1'] })
    await basketline.identity.identified({ userId: '00000000-0000-4000-8000-000000000001', visitorId: '00000000-0000-4000-8000-000000000002' })
    await basketline.identity.deleteUser('00000000-0000-4000-8000-000000000001')
    expect(api.retailCalls().map((c) => [c.path, c.body])).toEqual([
      ['/api/v1/retail/catalog', { events: [
        { eventName: 'product_upserted', updatedAt: '2026-10-30T09:00:00.000Z', data: { productId: 'SKU-1', sellerId: 'acme', name: 'Earbuds', price: 2999 } },
        { eventName: 'product_upserted', updatedAt: '2026-10-31T10:00:00.000Z', data: { productId: 'SKU-2', name: 'Cable' } },
      ] }],
      ['/api/v1/retail/campaigns', { events: [
        { eventName: 'campaign_upserted', updatedAt: '2026-10-31T10:00:00.000Z', data: { campaignId: 'diwali', sellerId: 'acme', title: 'Diwali', status: 'active', productIds: ['SKU-1'] } },
      ] }],
      ['/api/v1/retail/identity', { events: [
        { eventName: 'user_identified', updatedAt: '2026-10-31T10:00:00.000Z', data: { userId: '00000000-0000-4000-8000-000000000001', visitorId: '00000000-0000-4000-8000-000000000002' } },
      ] }],
      ['/api/v1/retail/identity', { events: [
        { eventName: 'user_deleted', updatedAt: '2026-10-31T10:00:00.000Z', data: { userId: '00000000-0000-4000-8000-000000000001' } },
      ] }],
    ])
  })

  it('splits large sends into requests of 500', async () => {
    const { api, basketline } = server()
    await basketline.catalog.removeProduct(Array.from({ length: 1201 }, (_, i) => `SKU-${i}`))
    expect(api.retailCalls().map((c) => c.body.events.length)).toEqual([500, 500, 201])
  })

  it('retries a 5xx once, renews the token after a 401, and throws what the API refused', async () => {
    vi.useFakeTimers()
    const statuses = [503, 202, 401, 202, 400]
    const { api, basketline } = server(fakeServerApi(() => statuses.shift() ?? 202))
    const retried = basketline.catalog.upsertSeller({ sellerId: 'acme', name: 'Acme' })
    await vi.advanceTimersByTimeAsync(1000)
    await retried
    await basketline.catalog.upsertSeller({ sellerId: 'acme', name: 'Acme' })
    expect(api.retailCalls().map((c) => c.headers.get('Authorization'))).toEqual(['Bearer integration-1', 'Bearer integration-1', 'Bearer integration-1', 'Bearer integration-2'])
    await expect(basketline.campaigns.remove('diwali')).rejects.toMatchObject({ message: '1 campaigns updates not sent (400 VALIDATION_ERROR)', details: { status: 400, cause: ['bad'] } })
  })

  it('throws when the API key is refused', async () => {
    const fetch = vi.fn(async () => Response.json({ error: { code: 'INVALID_API_KEY' } }, { status: 401 })) as unknown as typeof globalThis.fetch
    const basketline = createBasketlineServer({ apiUrl: API, tenantId: TENANT, apiKey: 'bl_sk_wrong', fetch })
    await expect(basketline.catalog.removeProduct('SKU-1')).rejects.toThrow(/integration token .*401 INVALID_API_KEY/)
  })
})

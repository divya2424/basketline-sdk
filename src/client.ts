import { buildEvent, isStoreRecordId, type ApiEvent, type EventFields, type EventName, type FieldsFor, type IdentityEvent, type IdentityFields, type InteractionEvent } from './events'
import { tokenExpiry, visitorIdFor, type KeyValueStorage } from './identity'

export interface BasketlineOptions {
  /** The Basketline API, e.g. "https://api.example.com/api/v1" (the dashboard's setup code shows yours). */
  apiUrl: string
  /** Your tenant ID (UUID), from Basketline. */
  tenantId: string
  /** Which of your stores the events come from: your own ID or a UUID (optional). */
  storeId?: string
  /** The app the events come from (default "web"). */
  clientType?: 'web' | 'mobile'
  /** Events per request (default 20, at most 100). */
  batchSize?: number
  /** How long the first queued event waits for others (default 2000 ms). */
  flushAfterMs?: number
  /** Where the visitor ID is kept (default localStorage; without one, it lasts for the page). */
  storage?: KeyValueStorage
  /** Called with anything that went wrong; the SDK never throws into your page. */
  onError?: (error: BasketlineError) => void
  /** Logs each event and request to the console. */
  debug?: boolean
  /** The fetch to use (default globalThis.fetch); for tests and unusual runtimes. */
  fetch?: typeof fetch
}

export interface Identify {
  /** The ID Basketline returned for this shopper with their token (POST /auth/shopper-token's userId). */
  userId: string
  /** Returns a token for this shopper: a shopper token from your backend (or a Basketline access token). */
  getToken: () => string | Promise<string>
}

export class BasketlineError extends Error {
  constructor(
    message: string,
    readonly details: { status?: number; code?: string; event?: unknown; cause?: unknown } = {},
  ) {
    super(message)
    this.name = 'BasketlineError'
  }
}

type Sender = { kind: 'visitor' } | ({ kind: 'registered' } & Identify)
interface Batch {
  sender: Sender
  events: ApiEvent[]
}

/** Visitor tokens last 30 minutes; a new one is fetched a little before. Other tokens: before their exp. */
const RENEW_BEFORE_MS = 5 * 60 * 1000
const FALLBACK_TOKEN_MS = 25 * 60 * 1000
const MAX_RETRY_WAIT_MS = 10_000

/**
 * The Basketline client for one store. Events are queued and posted in batches
 * (batchSize, or flushAfterMs after the first, or when the page is hidden), with
 * the identity their token was issued for: the visitor's, or after identify(),
 * the signed-in shopper's. Nothing it does can break the page: problems go to
 * onError.
 */
export function createBasketline(options: BasketlineOptions) {
  const {
    apiUrl,
    tenantId,
    storeId,
    clientType = 'web',
    batchSize = 20,
    flushAfterMs = 2000,
    onError = (error: BasketlineError) => console.warn('[basketline]', error.message, error.details),
    debug = false,
  } = options
  const base = apiUrl.replace(/\/+$/, '')
  const doFetch: typeof fetch = (input, init) => (options.fetch ?? globalThis.fetch)(input, init)
  const newId = () => crypto.randomUUID()
  const storage = options.storage ?? (typeof localStorage === 'undefined' ? undefined : safeLocalStorage())
  const limit = Math.min(Math.max(1, batchSize), 100)

  let sender: Sender = { kind: 'visitor' }
  let queue: ApiEvent[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  let inFlight: Promise<void> = Promise.resolve()
  // One cached token per sender: the visitor's, and the current shopper's.
  const tokens = new Map<Sender, { token: Promise<string>; renewAt: number }>()

  const report = (error: BasketlineError) => {
    try {
      onError(error)
    } catch {
      // A failing onError mustn't break the page either.
    }
  }
  const log = (...args: unknown[]) => debug && console.debug('[basketline]', ...args)
  if (storeId !== undefined && !isStoreRecordId(storeId)) report(new BasketlineError('storeId must be a UUID or your own ID (letters, digits, ._:/-, up to 128); events are sent without it'))
  const store = storeId !== undefined && isStoreRecordId(storeId) ? { storeId } : {}

  function visitorId() {
    return visitorIdFor(tenantId, storage, newId)
  }

  // The shopper signed in on this browser, so identify() on every page load sends login once.
  const signedInKey = `basketline:signed-in:${tenantId}`
  function signedIn(): string | null {
    try {
      return storage?.getItem(signedInKey) || null
    } catch {
      return null
    }
  }
  function rememberSignedIn(userId: string) {
    try {
      storage?.setItem(signedInKey, userId)
    } catch {
      // Without storage, a reload sends login again.
    }
  }

  async function fetchVisitorToken(): Promise<string> {
    const res = await doFetch(`${base}/auth/visitor`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', tenant_id: tenantId },
      body: JSON.stringify({ userId: visitorId(), clientType }),
    })
    if (!res.ok) throw await apiError(res, 'could not get a visitor token')
    return ((await res.json()) as { visitorToken: string }).visitorToken
  }

  function tokenFor(who: Sender, fresh = false): Promise<string> {
    const cached = tokens.get(who)
    if (cached && !fresh && cached.renewAt > Date.now()) return cached.token
    const token = Promise.resolve(who.kind === 'visitor' ? fetchVisitorToken() : who.getToken())
    const entry = { token, renewAt: Date.now() + FALLBACK_TOKEN_MS }
    tokens.set(who, entry)
    token.then(
      (value) => {
        const exp = tokenExpiry(value)
        if (exp) entry.renewAt = exp - RENEW_BEFORE_MS
      },
      // A failed request is retried with the next batch.
      () => tokens.get(who) === entry && tokens.delete(who),
    )
    return token
  }

  function identity(who: Sender) {
    return who.kind === 'visitor' ? { userId: visitorId(), userType: 'visitor' } : { userId: who.userId.toLowerCase(), userType: 'registered' }
  }

  async function post(batch: Batch, token: string) {
    return doFetch(`${base}/analytics/events`, {
      method: 'POST',
      // keepalive: the last batch still arrives while the page unloads.
      keepalive: true,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, tenant_id: tenantId },
      body: JSON.stringify({ tenantId, ...store, ...identity(batch.sender), events: batch.events }),
    })
  }

  /** Sends one batch: a 401 gets a fresh token once, a 429 or 5xx (or no network) one retry after a pause. */
  async function deliver(batch: Batch) {
    let res: Response | undefined
    let retried = false
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        res = await post(batch, await tokenFor(batch.sender, attempt > 0 && res?.status === 401))
      } catch (cause) {
        if (retried) throw new BasketlineError('events not sent: network error', { cause })
        retried = true
        await pause(1000)
        continue
      }
      if (res.ok) {
        log('sent', batch.events.length, 'events')
        return
      }
      if (res.status === 401 && attempt === 0) continue
      if ((res.status === 429 || res.status >= 500) && !retried) {
        retried = true
        await pause(Math.min(Number(res.headers.get('Retry-After') ?? 1) * 1000 || 1000, MAX_RETRY_WAIT_MS))
        continue
      }
      break
    }
    throw await apiError(res!, `${batch.events.length} events not sent`)
  }

  function flushNow(): Promise<void> {
    clearTimeout(timer)
    timer = undefined
    if (queue.length === 0) return inFlight
    const batches: Batch[] = []
    for (let i = 0; i < queue.length; i += limit) batches.push({ sender, events: queue.slice(i, i + limit) })
    queue = []
    // In order, so a shopper's batches never overtake each other.
    inFlight = inFlight.then(() =>
      batches.reduce<Promise<void>>((chain, batch) => chain.then(() => deliver(batch).catch((error) => report(asError(error)))), Promise.resolve()),
    )
    return inFlight
  }

  function enqueue(eventName: string, fields: EventFields): string | null {
    try {
      const built = buildEvent(eventName, fields, newId(), new Date())
      if ('error' in built) {
        report(new BasketlineError(`event dropped: ${built.error}`, { event: { eventName, ...fields } }))
        return null
      }
      if (built.dropped.length > 0) report(new BasketlineError(`properties dropped (personal data): ${built.dropped.join(', ')}`, { event: built.event }))
      queue.push(built.event)
      log('queued', built.event)
      if (queue.length >= limit) void flushNow()
      else timer ??= setTimeout(() => void flushNow(), flushAfterMs)
      return built.event.eventId
    } catch (error) {
      report(asError(error))
      return null
    }
  }

  if (typeof document !== 'undefined') {
    const flushOnHide = () => {
      if (document.visibilityState === 'hidden') void flushNow()
    }
    document.addEventListener('visibilitychange', flushOnHide)
    addEventListener('pagehide', () => void flushNow())
  }

  return {
    /**
     * Sends what the shopper did (see INTERACTION_EVENTS), e.g. track('click', { campaignId, productId }).
     * impression and click need a campaignId, add_to_cart a productId: an add to
     * cart is credited to the shopper's latest ad click on that product within 7 days.
     * Returns the event's ID, or null if it was invalid (see onError).
     */
    track: <E extends InteractionEvent>(eventName: E, ...[fields]: {} extends FieldsFor<E> ? [fields?: FieldsFor<E>] : [fields: FieldsFor<E>]) =>
      enqueue(eventName, fields ?? {}),

    /** Sends sign-in activity (see IDENTITY_EVENTS), e.g. identity('login_click', { pageName: 'header' }). */
    identity: (eventName: IdentityEvent, fields?: IdentityFields) => enqueue(eventName, fields ?? {}),

    /** @deprecated Use track() for interactions and identity() for sign-in activity. */
    sendEvent: <E extends EventName>(eventName: E, ...[fields]: {} extends FieldsFor<E> ? [fields?: FieldsFor<E>] : [fields: FieldsFor<E>]) =>
      enqueue(eventName, fields ?? {}),

    /**
     * The shopper signed in: later events are theirs, starting with a login event
     * (once per sign-in, so calling this on every page load is fine). Earlier queued
     * events still go out as the visitor.
     */
    identify(shopper: Identify) {
      void flushNow()
      sender = { kind: 'registered', userId: shopper.userId, getToken: shopper.getToken }
      const userId = shopper.userId.toLowerCase()
      if (signedIn() !== userId) {
        rememberSignedIn(userId)
        enqueue('login', {})
      }
    },
    /** The shopper signed out: a logout event as them, then back to this browser's visitor. */
    reset() {
      const leaving = sender
      if (leaving.kind === 'registered') enqueue('logout', {})
      rememberSignedIn('')
      // Their token goes once the logout (sent with it) is out.
      void flushNow().then(() => tokens.delete(leaving))
      sender = { kind: 'visitor' }
    },
    /** This browser's visitor ID for the store: send it to your backend's shopper-token call, so the visitor and the shopper stay one person. */
    get visitorId() {
      return visitorId()
    },
    /** Sends everything queued; resolves when it has been sent (or reported to onError). */
    flush: () => flushNow(),
  }
}

export type Basketline = ReturnType<typeof createBasketline>

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function asError(error: unknown): BasketlineError {
  return error instanceof BasketlineError ? error : new BasketlineError(error instanceof Error ? error.message : String(error), { cause: error })
}

async function apiError(res: Response, message: string): Promise<BasketlineError> {
  let code: string | undefined
  try {
    code = ((await res.json()) as { error?: { code?: string } }).error?.code
  } catch {
    // Not JSON.
  }
  return new BasketlineError(`${message} (${res.status}${code ? ` ${code}` : ''})`, { status: res.status, code })
}

function safeLocalStorage(): KeyValueStorage | undefined {
  try {
    return localStorage
  } catch {
    return undefined
  }
}

/**
 * The events Basketline accepts (backend/packages/contracts/src/analytics.ts;
 * test/events.test.ts keeps the two lists equal), and the checks the API would
 * otherwise reject a whole batch for.
 */

/** Counted by the campaign metrics; they always carry a campaignId. */
export const METRIC_EVENTS = ['impression', 'click'] as const
/** Storefront activity. add_to_cart (with its productId) is what click-to-basket credits to an earlier ad click. */
export const ACTIVITY_EVENTS = [
  'home_view',
  'campaign_navigation',
  'product_impression',
  'product_click',
  'add_to_cart',
  'cart_view',
  'cart_quantity_update',
  'remove_from_cart',
] as const
/** What shoppers do with ads and the store: track(). */
export const INTERACTION_EVENTS = [...METRIC_EVENTS, ...ACTIVITY_EVENTS] as const
/**
 * Sign-in activity: identity(). login and logout are also sent by identify() and
 * reset(). That a sign-in succeeded is for the retailer's server to say
 * (user_identified, see server.ts), since a page can claim anything.
 */
export const IDENTITY_EVENTS = ['login_click', 'signup_click', 'login', 'logout'] as const
export const EVENT_NAMES = [...INTERACTION_EVENTS, ...IDENTITY_EVENTS] as const
export type EventName = (typeof EVENT_NAMES)[number]
export type InteractionEvent = (typeof INTERACTION_EVENTS)[number]
export type IdentityEvent = (typeof IDENTITY_EVENTS)[number]
type MetricEvent = (typeof METRIC_EVENTS)[number]

export interface EventFields {
  /** Basketline's campaign UUID, or your own campaign ID (see isRetailerId). */
  campaignId?: string | null
  /** The product's UUID, or your own product ID such as a SKU. */
  productId?: string | null
  /** Where it happened, e.g. "home", "product"; at most 100 characters. */
  pageName?: string
  /** What on the page produced it, e.g. "carousel"; at most 100 characters. */
  featureName?: string
  /** How many items, for cart events; sent as properties.quantity. */
  quantity?: number
  /** Anything else useful; never personal data (see PERSONAL_DATA_KEY). */
  properties?: Record<string, unknown>
}

/** What identity events carry: where it happened and anything else useful (no IDs: the sender is the shopper). */
export type IdentityFields = Pick<EventFields, 'pageName' | 'featureName' | 'properties'>

/**
 * The fields an event needs: impression and click a campaignId, add_to_cart a
 * productId (what click-to-basket credits to an earlier ad click on it).
 */
export type FieldsFor<E extends EventName> = EventFields &
  (E extends MetricEvent ? { campaignId: string } : E extends 'add_to_cart' ? { productId: string } : unknown)

/** An event as the API takes it: what it's about (campaign, product, anything added later) is in properties. */
export interface ApiEvent {
  eventId: string
  eventName: EventName
  timestamp: string
  pageName?: string
  featureName?: string
  properties: {
    campaignId: string | null
    productId: string | null
    [key: string]: unknown
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value)
/** A campaign, product or seller ID: a UUID, or the retailer's own (a SKU, a code), as the API accepts them. */
export const isRetailerId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value)
/** UUIDs in one form (the API lowercases them too); a retailer's own ID as it is. */
const normalizeId = (id: string) => (isUuid(id) ? id.toLowerCase() : id)

/** Property keys that look like personal or payment data: dropped, so they never reach analytics. */
export const PERSONAL_DATA_KEY = /email|password|phone|cardnumber|cvv|address|firstname|lastname|fullname|username/i

/** The event to send, or the reason it can't be; personal-looking properties are dropped (and listed). */
export function buildEvent(eventName: string, fields: EventFields, eventId: string, now: Date): { event: ApiEvent; dropped: string[] } | { error: string } {
  if (!(EVENT_NAMES as readonly string[]).includes(eventName)) return { error: `unknown event "${eventName}"; use one of ${EVENT_NAMES.join(', ')}` }
  const isMetric = (METRIC_EVENTS as readonly string[]).includes(eventName)
  if (isMetric && !isRetailerId(fields.campaignId)) return { error: `${eventName} needs a campaignId` }
  if (eventName === 'add_to_cart' && !isRetailerId(fields.productId)) return { error: 'add_to_cart needs a productId' }
  if (fields.campaignId != null && !isRetailerId(fields.campaignId)) return { error: 'campaignId must be a UUID or your own ID (letters, digits, ._:/-, up to 128)' }
  if (fields.productId != null && !isRetailerId(fields.productId)) return { error: 'productId must be a UUID or your own ID (letters, digits, ._:/-, up to 128)' }
  if (fields.quantity !== undefined && !(Number.isInteger(fields.quantity) && fields.quantity > 0)) return { error: 'quantity must be a positive integer' }
  for (const name of ['pageName', 'featureName'] as const) {
    const value = fields[name]
    if (value !== undefined && (typeof value !== 'string' || value.trim() === '' || value.length > 100)) return { error: `${name} must be 1–100 characters` }
  }
  const extra: Record<string, unknown> = fields.quantity === undefined ? {} : { quantity: fields.quantity }
  const dropped: string[] = []
  for (const [key, value] of Object.entries(fields.properties ?? {})) {
    if (PERSONAL_DATA_KEY.test(key)) dropped.push(key)
    else extra[key] = value
  }
  // Last, so the validated IDs win over any of the same name in fields.properties.
  const properties: ApiEvent['properties'] = {
    ...extra,
    campaignId: fields.campaignId == null ? null : normalizeId(fields.campaignId),
    productId: fields.productId == null ? null : normalizeId(fields.productId),
  }
  return {
    dropped,
    event: {
      eventId,
      eventName: eventName as EventName,
      timestamp: now.toISOString(),
      ...(fields.pageName ? { pageName: fields.pageName } : {}),
      ...(fields.featureName ? { featureName: fields.featureName } : {}),
      properties,
    },
  }
}

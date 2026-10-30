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
  'login_click',
] as const
export const EVENT_NAMES = [...METRIC_EVENTS, ...ACTIVITY_EVENTS] as const
export type EventName = (typeof EVENT_NAMES)[number]
type MetricEvent = (typeof METRIC_EVENTS)[number]

export interface EventFields {
  campaignId?: string | null
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

/** Property keys that look like personal or payment data: dropped, so they never reach analytics. */
export const PERSONAL_DATA_KEY = /email|password|phone|cardnumber|cvv|address|firstname|lastname|fullname|username/i

/** The event to send, or the reason it can't be; personal-looking properties are dropped (and listed). */
export function buildEvent(eventName: string, fields: EventFields, eventId: string, now: Date): { event: ApiEvent; dropped: string[] } | { error: string } {
  if (!(EVENT_NAMES as readonly string[]).includes(eventName)) return { error: `unknown event "${eventName}"; use one of ${EVENT_NAMES.join(', ')}` }
  const isMetric = (METRIC_EVENTS as readonly string[]).includes(eventName)
  if (isMetric && !isUuid(fields.campaignId)) return { error: `${eventName} needs a campaignId (UUID)` }
  if (eventName === 'add_to_cart' && !isUuid(fields.productId)) return { error: 'add_to_cart needs a productId (UUID)' }
  if (fields.campaignId != null && !isUuid(fields.campaignId)) return { error: 'campaignId must be a UUID' }
  if (fields.productId != null && !isUuid(fields.productId)) return { error: 'productId must be a UUID' }
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
    campaignId: fields.campaignId?.toLowerCase() ?? null,
    productId: fields.productId?.toLowerCase() ?? null,
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

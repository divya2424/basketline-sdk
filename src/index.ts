/**
 * @divya2424/basketline-sdk: send ad and shopper events to Basketline from any website.
 *
 *   const bl = createBasketline({ apiUrl, tenantId, storeId })
 *   bl.track('impression', { campaignId })
 *   bl.track('click', { campaignId, productId })
 *   bl.track('add_to_cart', { productId, quantity: 1 })
 *   bl.identity('login_click')
 *   bl.identify({ userId, getToken })   // after sign-in, with a shopper token from your backend (sends login)
 *   bl.reset()                          // after sign-out (sends logout)
 *
 * A store's backend sends its catalog and campaigns with
 * @divya2424/basketline-sdk/server (never in a browser: it holds the API key).
 * See README.md.
 */
export { BasketlineError, createBasketline, type Basketline, type BasketlineOptions, type Identify } from './client'
export {
  ACTIVITY_EVENTS,
  EVENT_NAMES,
  IDENTITY_EVENTS,
  INTERACTION_EVENTS,
  METRIC_EVENTS,
  type EventFields,
  type EventName,
  type FieldsFor,
  type IdentityEvent,
  type IdentityFields,
  type InteractionEvent,
} from './events'
export type { KeyValueStorage } from './identity'

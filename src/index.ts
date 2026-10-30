/**
 * @divya2424/basketline-sdk: send ad and shopper events to Basketline from any website.
 *
 *   const bl = createBasketline({ apiUrl, tenantId })
 *   bl.sendEvent('impression', { campaignId })
 *   bl.sendEvent('click', { campaignId, productId })
 *   bl.sendEvent('add_to_cart', { productId, quantity: 1 })
 *   bl.identify({ userId, getToken })   // after sign-in, with a shopper token from your backend
 *
 * See README.md.
 */
export { BasketlineError, createBasketline, type Basketline, type BasketlineOptions, type Identify } from './client'
export { ACTIVITY_EVENTS, EVENT_NAMES, METRIC_EVENTS, type EventFields, type EventName, type FieldsFor } from './events'
export type { KeyValueStorage } from './identity'

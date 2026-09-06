// `["EVENT", <event>, <payment>]` — assembling and splitting the three-element message.
//
// Why a third element rather than a separate event (PLAN D2): with the payment in the same
// message the binding is **structural**, which removes pending state, TTLs and GC entirely.

import { parsePaymentEnvelope } from './envelope.js';
import type { NostrEventLike, PaymentEnvelope } from './types.js';

export const EVENT_MESSAGE_TYPE = 'EVENT';

/** The standard two-element message, for free events and non-paying relays. */
export function encodeEventMessage(event: NostrEventLike): string;
/** Three elements, sent **only to paying relays**; everyone else gets the standard form. */
export function encodeEventMessage(event: NostrEventLike, envelope: PaymentEnvelope): string;
export function encodeEventMessage(event: NostrEventLike, envelope?: PaymentEnvelope): string {
  const head = `["EVENT",${JSON.stringify(event)}`;
  return envelope === undefined ? `${head}]` : `${head},${JSON.stringify(envelope)}]`;
}

/**
 * Splice an envelope into an already-serialised EVENT message.
 *
 * nostr-tools hardcodes `this.send('["EVENT",' + JSON.stringify(event) + ']')`, so patching
 * the public `send` and editing the string is the only clean way in — `publish()` still
 * registers the OK resolver, so responses keep working. No private access, no fork.
 *
 * If it isn't an EVENT message, or the shape is unexpected, **return the original**:
 * failing to attach payment costs a publish, but mangling a REQ/CLOSE/AUTH breaks the socket.
 */
export function spliceEnvelope(rawMessage: string, envelope: PaymentEnvelope): string {
  const trimmed = rawMessage.trimEnd();
  if (!trimmed.startsWith('["EVENT"') || !trimmed.endsWith(']')) return rawMessage;
  return `${trimmed.slice(0, -1)},${JSON.stringify(envelope)}]`;
}

export interface SplitEventMessage {
  /** The standard two-element message to hand the validator (a new array). */
  message: unknown[];
  /** `null` when there is no third element, or its shape is wrong. */
  envelope: PaymentEnvelope | null;
}

/**
 * Strip the envelope at the relay's entry point — call this **before validation**.
 *
 * `@nostr-relay/validator` types the EVENT message as
 * `z.tuple([z.literal('EVENT'), eventSchema])`, which rejects extra elements (measured:
 * `Array must contain at most 2 element(s)`). Inserting this ahead of
 * `validateIncomingMessage()` in our fork means **no `@nostr-relay/*` package needs forking**.
 *
 * A broken envelope still lets the message through, so the event is validated normally and
 * rejected with the accurate reason (`payment-required`). Collapsing that into a parse error
 * leaves the client unable to tell whether retrying would help.
 */
export function takePaymentEnvelope(data: unknown): SplitEventMessage | null {
  if (!Array.isArray(data)) return null;
  if (data[0] !== EVENT_MESSAGE_TYPE) return null;
  if (data.length <= 2) return { message: data.slice(0, 2), envelope: null };
  return { message: data.slice(0, 2), envelope: parsePaymentEnvelope(data[2]) };
}

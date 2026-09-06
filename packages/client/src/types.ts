import type {
  NostrEventLike,
  PaymentEnvelope,
  PaymentTerms,
} from '@nostr-paywall/protocol';

export interface PaymentRequest {
  relayUrl: string;
  /** A signed event; `id` is final. */
  event: NostrEventLike;
  /** Terms the relay advertised via NIP-11: amount, methods, mints. */
  terms: PaymentTerms;
  /** What the relay wants for this event. */
  amountMsat: number;
}

/**
 * Injection point for payment capability.
 *
 * Copied from how nostr-tools solved NIP-42 (`automaticallyAuth`): the signing key lives in
 * the app, so does the wallet, and the pool only takes a callback.
 *
 * Given a relay URL, return `null` (we do not pay this relay) or a payment function.
 * That function returning `null` abandons this one payment (over budget, user declined).
 */
export type Payer = (
  relayUrl: string,
) => null | ((req: PaymentRequest) => Promise<PaymentEnvelope | null>);

/**
 * Publishing failed because there was no way to pay, or payment was refused.
 *
 * **Must stay distinguishable from a generic network error.** By design the paid relay is
 * usually the recipient's inbox relay, so blurring the two produces the silent failure:
 * the reply never arrived and the UI said it did (PLAN §6.6a).
 */
export class PaymentUnavailableError extends Error {
  readonly name = 'PaymentUnavailableError';
  constructor(
    readonly relayUrl: string,
    readonly reason: 'no-payer' | 'declined' | 'failed' | 'unsupported',
    message: string,
  ) {
    super(message);
  }
}

/** What we have learned about a relay. */
export type RelayPolicy =
  /** Unknown. Try the standard two-element form. */
  | { kind: 'unknown' }
  /** Free relay; attach nothing. */
  | { kind: 'free' }
  /** Paid. With `terms` the predicate runs locally, enabling single-round-trip publishing. */
  | { kind: 'paid'; terms: PaymentTerms; learnedAt: number };

/** For apps that want to persist the policy cache. Memory-only if omitted. */
export interface PolicyStore {
  load(): Record<string, RelayPolicy> | Promise<Record<string, RelayPolicy>>;
  save(policies: Record<string, RelayPolicy>): void | Promise<void>;
}

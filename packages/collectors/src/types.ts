// The collector contract. This is the **only layer that touches money**.
//
// Splitting `validate` from `collect` is the point: the ordering in PLAN §3.4 falls out of
// it. `validate` moves nothing, so the relay can rule out every non-payment rejection first;
// `collect` runs only once that gate is passed.

import type { PaymentEnvelope } from '@nostr-paywall/protocol';

export interface CollectContext {
  /** The event this payment buys. Used for idempotency (PLAN §3.6). */
  eventId: string;
  /** The price the predicate computed. */
  priceMsat: number;
}

export type ValidateResult =
  | {
      ok: true;
      /**
       * Double-spend key, and the lookup key for idempotency. For Cashu these are
       * the input proofs' secrets. The relay puts a UNIQUE constraint on them.
       */
      refs: string[];
      /** What the envelope actually carries. */
      amountMsat: number;
    }
  | {
      ok: false;
      /**
       * A **human-readable sentence**, placed verbatim into the OK message.
       * Ordinary clients show this in a toast, so it has to make manual recovery possible.
       */
      reason: string;
    };

export interface CollectResult {
  refs: string[];
  /** What actually became ours, after fees. */
  amountMsat: number;
  /**
   * The collected proofs. The relay **must persist these** — one restart without them
   * and the collected ecash is gone, because it is bearer money with no recovery path.
   */
  proofs: unknown[];
  /**
   * A token to hand back if storage fails, encoding the freshly swapped proofs.
   *
   * `collect` returns it, so no separate `refund()` is needed — what we would return is
   * already in hand at collection time.
   *
   * **`null` if encoding failed.** Throwing there would blow up *after* taking the money and
   * disable the refund path in PLAN §3.4 step 7 entirely. `proofs` survives either way, so the
   * operator can still recover manually.
   */
  refundToken: string | null;
}

export interface Collector {
  /** Must match the envelope's `method`. */
  readonly method: string;

  /** Boot gate (mint policy and so on). On failure the relay must not start. */
  init(): Promise<void>;

  /** **Moves nothing.** Shape, policy and amount only. */
  validate(envelope: PaymentEnvelope, ctx: CollectContext): Promise<ValidateResult>;

  /** Actual collection. Only ever called on an envelope `validate` approved. */
  collect(envelope: PaymentEnvelope, ctx: CollectContext): Promise<CollectResult>;
}

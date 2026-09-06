// float → `Payer` adapter. This is the entry point an app actually uses.

import type { Payer, PaymentRequest } from '@nostr-paywall/client';
import type { PaymentEnvelope, PaymentTerms } from '@nostr-paywall/protocol';
import type { EcashFloat } from './float.js';

/**
 * Choose a mint from what the relay advertised.
 *
 * With `allowedMints` the choice is restricted to the intersection — the place an app pins
 * the mints it trusts. Using whatever a relay names means letting the relay decide where
 * your money is held.
 */
export function pickMint(
  terms: PaymentTerms,
  allowedMints?: readonly string[],
): string | null {
  for (const m of terms.methods) {
    if (m.type !== 'cashu') continue;
    const mints = (m as { mints?: unknown }).mints;
    if (!Array.isArray(mints)) continue;
    for (const mint of mints) {
      if (typeof mint !== 'string') continue;
      if (!allowedMints || allowedMints.includes(mint)) return mint;
    }
  }
  return null;
}

export interface FloatPayerOptions {
  /** Mints the app trusts. Omitted means accepting whatever the relay advertises. */
  allowedMints?: readonly string[];
  /** Decide per relay whether to pay at all. Omitted means always. */
  shouldPay?: (relayUrl: string) => boolean;
  onError?: (e: unknown, req: PaymentRequest) => void;
}

/**
 * Plug straight into `PaidPool({ payer })`.
 *
 * Returns `null` on failure so the pool converts it to
 * `PaymentUnavailableError(declined)`. Throwing here would blur the cause.
 */
export function createFloatPayer(float: EcashFloat, opts: FloatPayerOptions = {}): Payer {
  return (relayUrl: string) => {
    if (opts.shouldPay && !opts.shouldPay(relayUrl)) return null;

    return async (req: PaymentRequest): Promise<PaymentEnvelope | null> => {
      const mint = pickMint(req.terms, opts.allowedMints);
      if (!mint) return null; // the relay accepts no mint we are willing to use

      // Relay prices are msat, but a Cashu sat keyset only expresses whole sats.
      // Underpaying is rejected, so round up.
      const amountSats = Math.ceil(req.amountMsat / 1000);

      try {
        return await float.spend(mint, amountSats, {
          eventId: req.event.id,
          relayUrl: req.relayUrl,
        });
      } catch (e) {
        opts.onError?.(e, req);
        return null;
      }
    };
  };
}

// The publish flow, kept separate from any pool implementation.
//
// It deals with **publishing to one relay** rather than extending `SimplePool`, so it can be
// reused on top of another pool (NDK and friends — PLAN §6.7).

import {
  parseOkReason,
  parsePaymentTerms,
  priceFor,
  spliceEnvelope,
  type NostrEventLike,
  type PaymentEnvelope,
} from '@nostr-paywall/protocol';
import {
  PaymentUnavailableError,
  type Payer,
  type RelayPolicy,
} from './types.js';

/** Just the part of nostr-tools' `AbstractRelay` we use. */
export interface RelayLike {
  url: string;
  send(message: string): Promise<void> | void;
  publish(event: NostrEventLike): Promise<string>;
}

export interface PublishDeps {
  payer: Payer;
  /**
   * Obtain the relay handle **every time**.
   *
   * Payment sits between the two publish attempts (user confirmation plus a lightning
   * payment), and during those tens of seconds the pool's idle timeout (20s by default)
   * closes the connection. Republishing on a closed handle waits for a reconnect and hits
   * the 4.4s publish timeout as `publish timed out`. Measured, not theorised.
   */
  getRelay(): Promise<RelayLike>;
  getPolicy(url: string): RelayPolicy;
  setPolicy(url: string, policy: RelayPolicy): void;
  /** Fetch the NIP-11 document. Only called after a rejection (PLAN D8). */
  fetchRelayInformation(url: string): Promise<unknown>;
}

/**
 * Splice the envelope into an already-serialised EVENT message.
 *
 * nostr-tools' `publish()` does two things — register the OK resolver and send — and the
 * resolver map is private. So we override the public `send` on the instance, edit only the
 * string, and let `publish()` run as usual; OK correlation keeps working.
 *
 * One-shot: restored on first call. Concurrent publishes to the same relay can overlap, so
 * the target is identified by event id.
 */
async function publishWithEnvelope(
  relay: RelayLike,
  event: NostrEventLike,
  envelope: PaymentEnvelope,
): Promise<string> {
  // Keep the original **by reference**. Wrapping in bind() yields a different function on
  // restore, and once wrappers stack you can no longer tell which one was the original.
  const originalSend = relay.send;
  const ownSend = Object.prototype.hasOwnProperty.call(relay, 'send');
  const call = (message: string) => originalSend.call(relay, message);

  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    // If it was a prototype method, delete the own property to restore the original shape.
    if (ownSend) (relay as { send: RelayLike['send'] }).send = originalSend;
    else delete (relay as Partial<RelayLike>).send;
  };

  (relay as { send: RelayLike['send'] }).send = (message: string) => {
    // Not our event: pass it through untouched (guards concurrent publishes).
    if (!message.includes(event.id)) return call(message);
    restore();
    return call(spliceEnvelope(message, envelope));
  };

  try {
    return await relay.publish(event);
  } finally {
    restore();
  }
}

async function pay(
  deps: PublishDeps,
  relayUrl: string,
  event: NostrEventLike,
  policy: Extract<RelayPolicy, { kind: 'paid' }>,
  amountMsat: number,
): Promise<PaymentEnvelope> {
  const payFn = deps.payer(relayUrl);
  if (!payFn) {
    throw new PaymentUnavailableError(
      relayUrl,
      'no-payer',
      `${relayUrl} wants ${amountMsat / 1000} sat to publish, and no payment method is available`,
    );
  }

  let envelope: PaymentEnvelope | null;
  try {
    envelope = await payFn({ relayUrl, event, terms: policy.terms, amountMsat });
  } catch (e) {
    throw new PaymentUnavailableError(relayUrl, 'failed', `payment failed: ${(e as Error).message}`);
  }
  if (!envelope) {
    throw new PaymentUnavailableError(relayUrl, 'declined', `payment for ${relayUrl} was declined`);
  }
  return envelope;
}

/**
 * Publish to one relay, attaching payment when required.
 *
 * - Unknown relay → send the standard form; on rejection, read NIP-11, learn, retry
 * - Known free → standard form (nothing in the ecosystem sees anything unusual)
 * - Known paid → evaluate the predicate **locally** and send three elements in one shot
 */
export async function publishToRelay(
  deps: PublishDeps,
  url: string,
  event: NostrEventLike,
): Promise<string> {
  const policy = deps.getPolicy(url);

  if (policy.kind === 'paid') {
    const price = priceFor(event, policy.terms);
    if (!price.charge) return (await deps.getRelay()).publish(event);
    if (!policy.terms.envelopeInEventMessage) {
      throw new PaymentUnavailableError(
        url,
        'unsupported',
        `${url} requires payment but does not accept an envelope on the EVENT message`,
      );
    }
    const envelope = await pay(deps, url, event, policy, price.amountMsat);
    // Re-acquire after payment; the connection may have closed in the meantime.
    return publishWithEnvelope(await deps.getRelay(), event, envelope);
  }

  // 'unknown' | 'free' — send the standard form first.
  try {
    // Success does not prove the relay is free: a plain note is accepted by paid relays too
    // (measured). `unknown` and `free` behave identically anyway, so nothing is lost.
    //
    // `await` is required: returning a promise from a try block without it means the
    // rejection never reaches the catch, which silently killed the whole learning path.
    return await (await deps.getRelay()).publish(event);
  } catch (e) {
    // The rejection is not guaranteed to be an Error: nostr-tools rejects `connect()` with a
    // **string** (`reject('connection timed out')`). Reading `.message` yields undefined,
    // which then blew up in the parser and **buried the real cause behind a TypeError**.
    const reason = e instanceof Error ? e.message : typeof e === 'string' ? e : String(e);
    const outcome = parseOkReason(false, reason);
    if (outcome.kind !== 'payment-required') throw e;

    // Only now do we read NIP-11. Nobody reads it proactively, but everybody reads it once
    // told to pay — and it lives at the websocket URL, so there is nothing to configure.
    const terms = parsePaymentTerms(await deps.fetchRelayInformation(url));
    if (!terms) {
      throw new PaymentUnavailableError(
        url,
        'unsupported',
        `${url} demands payment but its NIP-11 terms could not be read: ${outcome.message}`,
      );
    }
    const learned: RelayPolicy = { kind: 'paid', terms, learnedAt: Date.now() };
    deps.setPolicy(url, learned);

    const price = priceFor(event, terms);
    // The relay charged but our predicate says free — the two readings of the policy diverged.
    // Retrying quietly would loop forever, so stop here.
    if (!price.charge) {
      throw new PaymentUnavailableError(
        url,
        'unsupported',
        `${url} demanded payment but its advertised terms make this event free — policy mismatch`,
      );
    }
    const envelope = await pay(deps, url, event, learned, price.amountMsat);
    return publishWithEnvelope(await deps.getRelay(), event, envelope);
  }
}

// The charging predicate. This file is the **single shared truth** for relay and client.
//
// Two implementations always drift: the client decides an event is free and sends two
// elements, the relay decides it is chargeable and rejects. So the decision lives in one
// place — and the policy itself lives in the relay's advertised `terms`, not in this code.
// The client evaluates *the relay's* rule.

import { toMsat } from './terms.js';
import type { NostrEventLike, PaymentTerms, PublicationRule } from './types.js';

export type ChargeDecision =
  | { charge: false }
  | { charge: true; amountMsat: number; rule: PublicationRule };

const FREE: ChargeDecision = { charge: false };

/** Does the event carry any tag with one of these names? Names are case-sensitive. */
function hasAnyTag(event: NostrEventLike, names: readonly string[]): boolean {
  if (!Array.isArray(event.tags)) return false;
  for (const tag of event.tags) {
    // NIP-01 says a tag is one-or-more strings, but this is someone else's event.
    if (!Array.isArray(tag) || tag.length === 0) continue;
    const name = tag[0];
    if (typeof name === 'string' && names.includes(name)) return true;
  }
  return false;
}

function matches(event: NostrEventLike, rule: PublicationRule): boolean {
  if (!rule.kinds.includes(event.kind)) return false;
  // No `tags` → match on kind alone (vanilla NIP-11 compatibility).
  if (rule.tags === undefined) return true;
  return hasAnyTag(event, rule.tags);
}

/**
 * What does publishing this event to this relay cost?
 *
 * Rules are **first match wins**; anything unmatched is free.
 * No terms (not a paid relay, or not learned yet) is also free.
 */
export function priceFor(
  event: NostrEventLike,
  terms: PaymentTerms | null | undefined,
): ChargeDecision {
  if (!terms) return FREE;
  for (const rule of terms.rules) {
    if (!matches(event, rule)) continue;
    const amountMsat = toMsat(rule.amount, rule.unit);
    // The parser should have caught this, but a caller may hand-build terms.
    if (amountMsat === null) continue;
    if (amountMsat === 0) return FREE; // advertised at zero: listed but not actually charged
    return { charge: true, amountMsat, rule };
  }
  return FREE;
}

/** Shorthand for `priceFor(...).charge`, used to decide on single-round-trip publishing. */
export function shouldCharge(
  event: NostrEventLike,
  terms: PaymentTerms | null | undefined,
): boolean {
  return priceFor(event, terms).charge;
}

// ─── v1 default policy ──────────────────────────────────────────
//
// A relay seeds its own NIP-11 document from these, so the numbers live in exactly
// one place and the document cannot drift from the code.

/**
 * Chargeable kinds. An **allowlist**, because unknown kinds then default to free
 * (fail open). It is shorter than an exception list, and the structural `p` tags on
 * follow lists (kind 3), relay lists and sets drop out for nothing. The cost is that
 * spam can migrate to a new kind, so the list needs occasional review.
 *
 * - 1     replies and mentions (NIP-10: a reply inherits every ancestor `p` tag)
 * - 4     legacy DMs
 * - 6, 16 reposts (NIP-18: `e`+`p`, so it notifies and renders in followers' feeds)
 * - 7     reactions (NIP-25). NIP-30 permits custom emoji on kind 7, and `<image-url>`
 *         is arbitrary — an attacker's image renders in the target's notifications
 * - 1111  comments (NIP-22)
 * - 1059  gift wrap (NIP-17) — precisely the case a subscription cannot express
 */
export const V1_CHARGED_KINDS: readonly number[] = [1, 4, 6, 7, 16, 1111, 1059];

/**
 * Tags that make an event chargeable. Lowercase only.
 *
 * `q` (quote) is excluded: the quoted author isn't notified, and the auto-render happens
 * in the *quoting* author's followers' feeds. That isn't theft of attention.
 * NIP-22's uppercase `E`/`P` (root scope) are excluded too: when the parent is a nostr
 * event the lowercase pair is always present as well, and web/podcast comments carry only
 * `I`/`i`, so nobody is notified and free is the right answer.
 */
export const V1_CHARGED_TAGS: readonly string[] = ['e', 'p'];

/** Flat v1 price: 1 sat. Per-kind and per-recipient pricing is a v2 concern. */
export const V1_PRICE_MSAT = 1000;

export function defaultRules(priceMsat: number = V1_PRICE_MSAT): PublicationRule[] {
  return [
    {
      kinds: [...V1_CHARGED_KINDS],
      tags: [...V1_CHARGED_TAGS],
      amount: priceMsat,
      unit: 'msats',
    },
  ];
}

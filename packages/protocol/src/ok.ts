// Building OK responses (relay) and reading them (client).
//
// Both live in one file so the prefix strings cannot diverge — otherwise the relay sends
// "payment-required:" while the client looks for "payment_required:" and nobody notices.

// ─── prefixes ───────────────────────────────────────────────────
//
// NIP-01's eight standard prefixes (duplicate/pow/blocked/rate-limited/invalid/restricted/
// mute/error) have nothing for payment. Our own client is the consumer, so we add one — but
// **always include a human sentence**: ordinary clients surface this string in a toast,
// which gives manual payment as a fallback for free.

export const PREFIX_PAYMENT_REQUIRED = 'payment-required';
export const PREFIX_PAYMENT_INVALID = 'payment-invalid';
export const PREFIX_DUPLICATE = 'duplicate';
export const PREFIX_ERROR = 'error';
/** A NIP-01 standard prefix, for rejections where retrying is the right move. */
export const PREFIX_RATE_LIMITED = 'rate-limited';

/** Key for returning collected money after a storage failure; the OK is the only channel. */
export const REFUND_KEY = 'refund=';

// ─── relay side: building ───────────────────────────────────────

export function okPaymentRequired(humanReason: string): string {
  return `${PREFIX_PAYMENT_REQUIRED}: ${humanReason}`;
}

export function okPaymentInvalid(humanReason: string): string {
  return `${PREFIX_PAYMENT_INVALID}: ${humanReason}`;
}

export function okDuplicate(): string {
  return `${PREFIX_DUPLICATE}: already have this event`;
}

/**
 * The same event is already being paid for.
 *
 * Not `payment-invalid`: that means "do not retry with this envelope", but the envelope is
 * fine and retrying shortly is correct. Hence `rate-limited`.
 */
export function okInProgress(): string {
  return `${PREFIX_RATE_LIMITED}: payment for this event is already in progress`;
}

/**
 * Collected, then storage failed. The token must travel with the message.
 *
 * This path exists because of the ordering in PLAN §3.4: every non-payment rejection is
 * checked first, so the only failure left after collection is infrastructure.
 */
export function okRefund(token: string, humanReason = 'storage failed'): string {
  return `${PREFIX_ERROR}: ${humanReason}; ${REFUND_KEY}${token}`;
}

// ─── client side: parsing ───────────────────────────────────────

export type OkOutcome =
  /** Stored. */
  | { kind: 'accepted' }
  /** Already present, free. The normal resting place for a retry. */
  | { kind: 'duplicate' }
  /** Payment required. If terms are unknown, this is the cue to fetch NIP-11 (PLAN D8). */
  | { kind: 'payment-required'; message: string }
  /** Envelope rejected (double spend, disallowed mint, bad shape). Do not retry it. */
  | { kind: 'payment-invalid'; message: string }
  /** Collected but not stored. Recover `token`. */
  | { kind: 'refunded'; token: string; message: string }
  /** Anything else. */
  | { kind: 'rejected'; prefix: string; message: string };

function splitPrefix(reason: string): { prefix: string; rest: string } {
  const i = reason.indexOf(':');
  if (i < 0) return { prefix: '', rest: reason.trim() };
  return { prefix: reason.slice(0, i).trim(), rest: reason.slice(i + 1).trim() };
}

/**
 * Extract the refund token. `refund=<token>`, whitespace-free.
 *
 * Tolerates non-string input, because callers cannot guarantee otherwise: nostr-tools'
 * `connect()` rejects with a **plain string** rather than an Error, so `(e as Error).message`
 * comes through as `undefined` (measured). Throwing here would bury the real cause.
 */
export function extractRefundToken(reason: unknown): string | null {
  if (typeof reason !== 'string') return null;
  const at = reason.indexOf(REFUND_KEY);
  if (at < 0) return null;
  const token = reason.slice(at + REFUND_KEY.length).trim().split(/\s/)[0];
  return token !== undefined && token.length > 0 ? token : null;
}

/**
 * Interpret the last two values of `["OK", <id>, <accepted>, <reason>]`.
 *
 * nostr-tools' `publish()` resolves with the reason string and rejects with
 * `new Error(reason)`, so a wrapper can call this on both paths.
 */
export function parseOkReason(accepted: boolean, reason: unknown): OkOutcome {
  const text = typeof reason === 'string' ? reason : '';
  const { prefix, rest } = splitPrefix(text);

  if (accepted) {
    // Acceptance can carry a prefix too (NIP-01 shows `duplicate:`).
    return prefix === PREFIX_DUPLICATE ? { kind: 'duplicate' } : { kind: 'accepted' };
  }

  // A refund outranks the prefix: treat a response carrying money as a generic error and
  // the money is simply lost.
  const token = extractRefundToken(text);
  if (token !== null) {
    // `message` is for humans; strip the machine-readable token clause.
    const cut = rest.indexOf(REFUND_KEY);
    const message = (cut < 0 ? rest : rest.slice(0, cut)).replace(/[\s;]+$/, '');
    return { kind: 'refunded', token, message };
  }

  switch (prefix) {
    case PREFIX_PAYMENT_REQUIRED:
      return { kind: 'payment-required', message: rest };
    case PREFIX_PAYMENT_INVALID:
      return { kind: 'payment-invalid', message: rest };
    default:
      return { kind: 'rejected', prefix, message: rest };
  }
}

// NIP-11 relay information document → PaymentTerms.
//
// The input is **untrusted remote JSON**. Whatever shape arrives, never throw; silently
// drop anything we cannot understand (fail open, i.e. treat the event as free).
// Failing to recognise a fee is safe. A parser that blows up and blocks publishing is not.

import type {
  PaymentMethod,
  PaymentTerms,
  PublicationRule,
} from './types.js';

// ─── unit normalisation ─────────────────────────────────────────
//
// NIP-11 examples use "msats" but real relays also write "sats". Normalise to msat.

const UNIT_TO_MSAT: Record<string, number> = {
  msat: 1,
  msats: 1,
  millisat: 1,
  millisats: 1,
  sat: 1000,
  sats: 1000,
};

/** Unknown unit → null, so the caller treats it as undecidable rather than free. */
export function toMsat(amount: number, unit: string): number | null {
  if (!Number.isFinite(amount) || amount < 0) return null;
  const mul = UNIT_TO_MSAT[unit.toLowerCase()];
  if (mul === undefined) return null;
  return amount * mul;
}

// ─── parsing ───────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function stringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === 'string' && x.length > 0);
  return out.length > 0 ? out : undefined;
}

function parseRule(v: unknown): PublicationRule | null {
  if (!isRecord(v)) return null;

  // An absent or empty `kinds` makes the rule inert. Vanilla NIP-11 could be read as
  // "no kinds means all kinds", but that turns one relay typo into charging for
  // everything. Anything touching money fails open.
  const kinds = Array.isArray(v['kinds'])
    ? v['kinds'].filter((k): k is number => typeof k === 'number' && Number.isInteger(k))
    : [];
  if (kinds.length === 0) return null;

  const amount = v['amount'];
  const unit = v['unit'];
  if (typeof amount !== 'number' || typeof unit !== 'string') return null;
  if (toMsat(amount, unit) === null) return null; // unknown unit → discard the rule

  const tags = stringArray(v['tags']);
  return tags ? { kinds, tags, amount, unit } : { kinds, amount, unit };
}

function parseMethod(v: unknown): PaymentMethod | null {
  if (!isRecord(v)) return null;
  const type = v['type'];
  if (typeof type !== 'string' || type.length === 0) return null;
  const unit = typeof v['unit'] === 'string' ? v['unit'] : 'sat';

  if (type === 'cashu') {
    const mints = stringArray(v['mints']);
    if (!mints) return null; // a cashu method without mints is unusable
    return { type: 'cashu', unit, mints };
  }
  if (type === 'ln-keysend') {
    const node = v['node'];
    if (typeof node !== 'string' || node.length === 0) return null;
    return { type: 'ln-keysend', unit, node };
  }
  // Preserve unknown methods so a client can tell the user "unsupported" specifically.
  return { ...v, type } as PaymentMethod;
}

/**
 * Extract payment terms from a NIP-11 document.
 *
 * Returns `null` if the relay is not paid, or if no rule could be read.
 * Terms are discovered lazily, after a rejection (PLAN D8) — nobody reads NIP-11 up front.
 */
export function parsePaymentTerms(info: unknown): PaymentTerms | null {
  if (!isRecord(info)) return null;

  const fees = info['fees'];
  const publication = isRecord(fees) ? fees['publication'] : undefined;
  const rules = Array.isArray(publication)
    ? publication.map(parseRule).filter((r): r is PublicationRule => r !== null)
    : [];
  if (rules.length === 0) return null; // no rules → not a paid relay as far as we care

  const pv = info['payment_v1'];
  const methods =
    isRecord(pv) && Array.isArray(pv['methods'])
      ? pv['methods'].map(parseMethod).filter((m): m is PaymentMethod => m !== null)
      : [];

  // Defaults to false. The three-element EVENT is non-standard, so only send it to relays
  // that explicitly advertise support.
  const envelopeInEventMessage =
    isRecord(pv) && pv['envelope_in_event_message'] === true;

  return { rules, methods, envelopeInEventMessage };
}

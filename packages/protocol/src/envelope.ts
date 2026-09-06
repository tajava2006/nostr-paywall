// Shape validation for the payment envelope. **No cryptography here** — that belongs to
// the per-rail collector.
//
// In the relay pipeline (PLAN §3.4) this is step 4: everything that must be rejected
// *before* money moves in step 5.

import { ENVELOPE_VERSION } from './types.js';
import type { CashuEnvelope, LnKeysendEnvelope, PaymentEnvelope } from './types.js';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * Parse an envelope; `null` if the shape is wrong.
 *
 * This is **untrusted input** on the relay side, so it never throws — throwing here
 * would take down a connection.
 */
export function parsePaymentEnvelope(v: unknown): PaymentEnvelope | null {
  if (!isRecord(v)) return null;
  if (v['v'] !== ENVELOPE_VERSION) return null;

  const method = v['method'];
  if (method === 'cashu') {
    const mint = v['mint'];
    const token = v['token'];
    if (typeof mint !== 'string' || mint.length === 0) return null;
    // Must be an encoded token string; an array makes the swap assemble with zero inputs.
    if (typeof token !== 'string' || token.length === 0) return null;
    const unit = typeof v['unit'] === 'string' ? v['unit'] : 'sat';
    return { v: ENVELOPE_VERSION, method: 'cashu', mint, unit, token } satisfies CashuEnvelope;
  }

  if (method === 'ln-keysend') {
    const node = v['node'];
    const nonce = v['nonce'];
    if (typeof node !== 'string' || node.length === 0) return null;
    // The nonce is derived, so it is always 32 bytes of hex. Enforcing the shape lets the
    // relay discard junk before computing a preimage.
    if (typeof nonce !== 'string' || !HEX64.test(nonce)) return null;
    return { v: ENVELOPE_VERSION, method: 'ln-keysend', node, nonce } satisfies LnKeysendEnvelope;
  }

  return null;
}

/**
 * Is the envelope from a mint the relay allows (PLAN §4.1 H1)?
 *
 * This check survives dropping P2PK, for a different reason: not a defence against
 * double spending, but the economic requirement that we can actually redeem the token.
 */
export function isMintAllowed(envelope: PaymentEnvelope, allowedMints: readonly string[]): boolean {
  if (envelope.method !== 'cashu') return true;
  return allowedMints.includes(envelope.mint);
}

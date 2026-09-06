// Shared protocol types. No runtime dependencies, so relay (node) and client (browser)
// use the same file. We deliberately don't import nostr-tools: a relay pulling this in
// shouldn't inherit a client's dependency tree.

/** Only the fields we read. Structurally compatible with nostr-tools' `Event`. */
export interface NostrEventLike {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

// ─── terms: what a relay advertises via NIP-11 ──────────────────────

/**
 * One entry of NIP-11 `fees.publication[]`.
 *
 * `tags` is our extension. Vanilla NIP-11 can only select by kind, which cannot express
 * "only events that notify someone". Meaning: `kind ∈ kinds` **AND** the event carries at
 * least one of `tags`. Omitting `tags` falls back to kind-only, so vanilla docs still parse.
 */
export interface PublicationRule {
  kinds: number[];
  /** Tag *names*. Case-sensitive ("e" ≠ "E"). Omit for kind-only matching. */
  tags?: string[];
  /** Amount in `unit`. Use `ChargeDecision.amountMsat` for the normalised value. */
  amount: number;
  unit: string;
}

export interface CashuMethod {
  type: 'cashu';
  unit: string;
  /** Mints the relay can redeem at. A client must pick from this list. */
  mints: string[];
}

export interface LnKeysendMethod {
  type: 'ln-keysend';
  unit: string;
  /** The relay's LN node pubkey; it feeds the derived preimage. */
  node: string;
}

/** Unknown methods are preserved rather than dropped, so a client can say "unsupported". */
export interface UnknownMethod {
  type: string;
  [k: string]: unknown;
}

export type PaymentMethod = CashuMethod | LnKeysendMethod | UnknownMethod;

export interface PaymentTerms {
  rules: PublicationRule[];
  methods: PaymentMethod[];
  /** Does the relay accept the three-element `["EVENT", event, payment]`? If not, no single round trip. */
  envelopeInEventMessage: boolean;
}

// ─── the payment envelope: third element of the EVENT message ───
//
// Plain JSON, not a signed event. There is no key to correlate, which keeps the
// payment unlinkable and removes a pile of code.

export const ENVELOPE_VERSION = 1;

export interface CashuEnvelope {
  v: number;
  method: 'cashu';
  mint: string;
  unit: string;
  /**
   * An **encoded NUT-00 token string** (`cashuB…`), not a raw proof array.
   *
   * Passing an array makes the relay's swap assemble with zero inputs and fail — v2 keyset
   * short ids are resolved during token decoding (measured: `Inputs: 0, Outputs: 0`).
   * A string also survives a JSON round trip untouched, which sidesteps cashu-ts v4 turning
   * `Proof.amount` into an `Amount` (a bigint wrapper) that serialises inconsistently.
   *
   * **Unlocked** — deliberately not P2PK-locked (see PLAN D5).
   */
  token: string;
}

export interface LnKeysendEnvelope {
  v: number;
  method: 'ln-keysend';
  node: string;
  /** Hex of `HMAC(client_secret, event_id ‖ node)`. Derived, never stored. */
  nonce: string;
}

export type PaymentEnvelope = CashuEnvelope | LnKeysendEnvelope;

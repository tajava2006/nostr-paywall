// The Cashu collector — the primary rail for v1.
//
// Tokens are **unlocked** (PLAN D5). If the client claws them back before we do, the swap
// fails and we simply do not store the event, so losing that race costs the relay nothing.

import type { Proof, Token } from '@cashu/cashu-ts';
import { isMintAllowed, type PaymentEnvelope } from '@nostr-paywall/protocol';
import { assertZeroFeeMints } from './mint-policy.js';
import type { CollectContext, CollectResult, Collector, ValidateResult } from './types.js';

// ─── lazy-loading cashu-ts ──────────────────────────────────────
//
// cashu-ts is ESM-only (`type: module`) while most relays using this package are CJS
// (NestJS default). A static import gets downlevelled to `require()` in the CJS build and
// dies with `SyntaxError: Unexpected token 'export'`. A dynamic import reads ESM from CJS
// fine, so only the runtime values are deferred; types are `import type` and vanish.
type CashuModule = typeof import('@cashu/cashu-ts');
let cashuPromise: Promise<CashuModule> | undefined;
function cashu(): Promise<CashuModule> {
  cashuPromise ??= import('@cashu/cashu-ts');
  return cashuPromise;
}

/** The minimum surface we use, so tests can cut the network. `Wallet` satisfies it. */
export interface WalletLike {
  loadMint(): Promise<void>;
  decodeToken(token: string): Token;
  receive(token: string | Token): Promise<Proof[]>;
}

export interface CashuCollectorOptions {
  /** Only mints we can redeem at (H1), all of them with `input_fee_ppk == 0` (H1b). */
  allowedMints: readonly string[];
  unit?: string;
  /** Injection point for tests and alternative implementations. */
  walletFactory?: (mint: string) => WalletLike;
  /** Skip the boot gate. **Tests only.** */
  skipFeeCheck?: boolean;
}

const SAT_TO_MSAT = 1000;

function sumSats(proofs: readonly { amount: unknown }[]): number {
  // cashu-ts v4's `Proof.amount` is an `Amount` (a bigint wrapper), not a number, and its
  // shape depends on how it travelled: JSON gives the string "1", structuredClone keeps
  // `{value: 1n}`. `Number()` on the latter is NaN, which silently corrupts the total.
  return proofs.reduce((s, p) => {
    const a = p.amount as unknown;
    if (typeof a === 'number') return s + a;
    if (typeof a === 'bigint') return s + Number(a);
    if (typeof a === 'string') return s + Number(a);
    if (a && typeof a === 'object' && 'value' in a) return s + Number((a as { value: unknown }).value);
    return Number.NaN;
  }, 0);
}

export class CashuCollector implements Collector {
  readonly method = 'cashu';

  private readonly allowedMints: readonly string[];
  private readonly unit: string;
  private readonly walletFactory: ((mint: string) => WalletLike) | undefined;
  private readonly skipFeeCheck: boolean;
  private readonly wallets = new Map<string, Promise<WalletLike>>();

  constructor(opts: CashuCollectorOptions) {
    this.allowedMints = opts.allowedMints;
    this.unit = opts.unit ?? 'sat';
    this.skipFeeCheck = opts.skipFeeCheck ?? false;
    this.walletFactory = opts.walletFactory;
  }

  /** Boot gate: one non-zero-ppk mint and we throw, so the relay never starts. */
  async init(): Promise<void> {
    if (!this.skipFeeCheck) await assertZeroFeeMints(this.allowedMints, this.unit);
    // Warm the wallets: `loadMint` takes 300ms–1s and has no business on the event path.
    await Promise.all(this.allowedMints.map((m) => this.wallet(m)));
  }

  private wallet(mint: string): Promise<WalletLike> {
    let w = this.wallets.get(mint);
    if (!w) {
      w = (async () => {
        const wallet =
          this.walletFactory?.(mint) ??
          ((new (await cashu()).Wallet(mint) as unknown) as WalletLike);
        await wallet.loadMint();
        return wallet;
      })();
      this.wallets.set(mint, w);
      // Caching a rejected promise would make the failure permanent.
      w.catch(() => this.wallets.delete(mint));
    }
    return w;
  }

  /**
   * **Moves nothing.** Mint policy, token shape and amount only.
   *
   * The returned `refs` are the input proofs' secrets: the relay uses them to block double
   * spends and to recognise an idempotent retry (same refs, same event id — PLAN §3.6).
   */
  async validate(envelope: PaymentEnvelope, ctx: CollectContext): Promise<ValidateResult> {
    if (envelope.method !== 'cashu') {
      return { ok: false, reason: `unsupported payment method: ${envelope.method}` };
    }
    if (!isMintAllowed(envelope, this.allowedMints)) {
      return { ok: false, reason: `mint not allowed: ${envelope.mint}` };
    }
    if (envelope.unit !== this.unit) {
      return { ok: false, reason: `unsupported unit: ${envelope.unit}` };
    }

    let decoded: Token;
    try {
      decoded = (await this.wallet(envelope.mint)).decodeToken(envelope.token);
    } catch (e) {
      return { ok: false, reason: `malformed cashu token: ${(e as Error).message}` };
    }

    // Never trust the envelope's `mint` field alone — the mint baked into the token is the
    // real one. Otherwise you can claim an allowlisted mint while carrying another's token.
    if (!this.allowedMints.includes(decoded.mint)) {
      return { ok: false, reason: `token issued by a different mint: ${decoded.mint}` };
    }

    const proofs = decoded.proofs ?? [];
    if (proofs.length === 0) return { ok: false, reason: 'cashu token carries no proofs' };

    const amountMsat = sumSats(proofs) * SAT_TO_MSAT;
    if (amountMsat < ctx.priceMsat) {
      return {
        ok: false,
        reason: `insufficient payment: ${amountMsat / SAT_TO_MSAT} sat < ${ctx.priceMsat / SAT_TO_MSAT} sat`,
      };
    }

    const refs = proofs.map((p) => p.secret);
    if (refs.some((s) => typeof s !== 'string' || s.length === 0)) {
      return { ok: false, reason: 'cashu proof missing secret' };
    }
    return { ok: true, refs, amountMsat };
  }

  /**
   * Actual collection. Call **only** on an envelope `validate` approved.
   *
   * The swap *is* the binding validity check — a `checkstate` query is TOCTOU and cannot
   * serve as a gate (PLAN §3.4).
   */
  async collect(envelope: PaymentEnvelope, ctx: CollectContext): Promise<CollectResult> {
    if (envelope.method !== 'cashu') throw new Error(`method mismatch: ${envelope.method}`);
    const wallet = await this.wallet(envelope.mint);

    const before = wallet.decodeToken(envelope.token);
    const refs = (before.proofs ?? []).map((p) => p.secret);

    const fresh = await wallet.receive(envelope.token);
    const amountMsat = sumSats(fresh) * SAT_TO_MSAT;
    if (amountMsat < ctx.priceMsat) {
      // With the ppk==0 gate in place this is unreachable. Reaching it means it was bypassed.
      throw new Error(
        `collected less than the price (${amountMsat} < ${ctx.priceMsat} msat). ` +
          `Check whether the mint fee gate (input_fee_ppk == 0) was bypassed.`,
      );
    }

    // Encoding can throw (a legacy keyset id, say). Throwing here happens **after** the money
    // is taken and would disable the refund path entirely, so swallow it — the raw proofs
    // travel alongside regardless.
    let refundToken: string | null = null;
    try {
      const { getEncodedToken } = await cashu();
      refundToken = getEncodedToken({ mint: envelope.mint, unit: this.unit, proofs: fresh });
    } catch {
      refundToken = null;
    }

    return { refs, amountMsat, proofs: fresh, refundToken };
  }
}

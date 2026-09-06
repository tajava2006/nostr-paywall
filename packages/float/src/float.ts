// The client-side ecash float.
//
// This is the **only route to rail independence** (PLAN D10). NWC has no keysend in its core
// method set, so whatever a relay accepts, the app only ever supplies `payInvoice` and
// `makeInvoice`: we buy ecash with that invoice (NUT-04) and spend a sat per event.

import type { Proof } from '@cashu/cashu-ts';
import type { PaymentEnvelope } from '@nostr-paywall/protocol';
import { normalizeProofs, sumSats } from './amount.js';
import { createLock, type FloatLock } from './lock.js';
import { findAffordableAmount, requestInvoice, resolveLightningAddress } from './lnurl.js';
import {
  emptyState,
  type FloatState,
  type FloatStore,
  type MintBucket,
  type PendingSpend,
  type RefundRecord,
  type SpendRecord,
} from './store.js';

// cashu-ts is ESM-only, so for CJS consumers only the runtime values are deferred (same
// reasoning as collectors). Types are `import type` and disappear at compile time.
type CashuModule = typeof import('@cashu/cashu-ts');
let cashuPromise: Promise<CashuModule> | undefined;
function cashu(): Promise<CashuModule> {
  cashuPromise ??= import('@cashu/cashu-ts');
  return cashuPromise;
}

export interface Funding {
  /** Top up: pay the mint's bolt11. Usually NWC `pay_invoice`. */
  payInvoice(bolt11: string): Promise<{ preimage: string }>;
  /** Sweep: melt the remaining ecash to here. Usually NWC `make_invoice`. */
  makeInvoice?(amountSats: number): Promise<string>;
}

export interface FloatLimits {
  /** Cap on what the float holds. Keeping it small is the real defence against eviction and XSS. */
  maxFloatSats: number;
  /** Top-up cap per period (24h by default). Library bookkeeping, not a cryptographic guarantee. */
  maxTopUpPerPeriodSats: number;
  periodMs?: number;
}

export interface EcashFloatOptions {
  store: FloatStore;
  funding: Funding;
  /** Spending limits; see `FloatLimits`. */
  limits?: Partial<FloatLimits>;
  /**
   * **Defaults to false.** Constructing a library must never spend a user's money (PLAN §6.6b).
   * Left off, a shortfall calls `onTopUpRequired`; without that either, it gives up.
   */
  autoTopUp?: boolean;
  /** Ask the app for consent. Returning `false` means no top-up. */
  onTopUpRequired?: (info: { mint: string; sats: number }) => Promise<boolean>;
  /** How much to buy at once. At 1 sat per event, 500 buys 500 publishes. */
  topUpSats?: number;
  lock?: FloatLock;
}

const DEFAULT_LIMITS: FloatLimits = {
  maxFloatSats: 500,
  maxTopUpPerPeriodSats: 2000,
  periodMs: 24 * 60 * 60 * 1000,
};

function bucket(state: FloatState, mint: string): MintBucket {
  state.mints[mint] ??= { proofs: [], pending: [] };
  return state.mints[mint]!;
}

// Amount shape varies by store, so go through the normalising helper (see amount.ts).
const sats = sumSats;

export class InsufficientFloatError extends Error {
  readonly name = 'InsufficientFloatError';
  constructor(readonly mint: string, readonly needSats: number, readonly haveSats: number) {
    super(`${mint} has ${haveSats} sat but ${needSats} sat is needed`);
  }
}

export class EcashFloat {
  private readonly lock: FloatLock;
  private readonly limits: FloatLimits;

  constructor(private readonly opts: EcashFloatOptions) {
    this.lock = opts.lock ?? createLock();
    this.limits = { ...DEFAULT_LIMITS, ...opts.limits };
  }

  /**
   * Load state, normalising proof amounts on the way in.
   *
   * Already-stored ecash has to survive too: a browser may hold proofs shaped `{value: 1n}`,
   * and failing to read them is simply losing the money.
   */
  private async loadState(): Promise<FloatState> {
    const state = (await this.opts.store.load()) ?? emptyState();
    for (const b of Object.values(state.mints)) {
      b.proofs = normalizeProofs(b.proofs) as Proof[];
      for (const p of b.pending) p.proofs = normalizeProofs(p.proofs) as Proof[];
    }
    return state;
  }

  private async mutate<T>(fn: (state: FloatState) => Promise<T>): Promise<T> {
    // Read, modify and write must be one critical section, or two tabs overwrite each
    // other's saved state and the ecash is gone.
    return this.lock.run(async () => {
      const state = await this.loadState();
      const out = await fn(state);
      await this.opts.store.save(state);
      return out;
    });
  }

  /** Balance per mint, in sats. */
  async balance(): Promise<Record<string, number>> {
    const state = await this.loadState();
    return Object.fromEntries(
      Object.entries(state.mints).map(([mint, b]) => [mint, sats(b.proofs)]),
    );
  }

  // ─── top up ─────────────────────────────────────────────────────

  private periodTopUpSats(state: FloatState, now: number): number {
    const since = now - (this.limits.periodMs ?? DEFAULT_LIMITS.periodMs!);
    return state.topUps.filter((t) => t.at >= since).reduce((s, t) => s + t.sats, 0);
  }

  /**
   * Buy ecash from a mint: NUT-04 quote (bolt11) → `funding.payInvoice` → mint.
   *
   * Returns `false` if a limit is hit or consent is withheld.
   */
  async topUp(mint: string, requestSats?: number): Promise<boolean> {
    const amount = requestSats ?? this.opts.topUpSats ?? this.limits.maxFloatSats;
    const now = Date.now();

    const allowed = await this.mutate(async (state) => {
      const have = sats(bucket(state, mint).proofs);
      if (have + amount > this.limits.maxFloatSats) return false;
      if (this.periodTopUpSats(state, now) + amount > this.limits.maxTopUpPerPeriodSats) return false;
      return true;
    });
    if (!allowed) return false;

    if (this.opts.onTopUpRequired) {
      if (!(await this.opts.onTopUpRequired({ mint, sats: amount }))) return false;
    } else if (!this.opts.autoTopUp) {
      // No explicit consent path and not automatic: spend nothing.
      return false;
    }

    const { Wallet } = await cashu();
    const wallet = new Wallet(mint);
    await wallet.loadMint();
    const quote = await wallet.createMintQuoteBolt11(amount);
    await this.opts.funding.payInvoice(quote.request);

    // Wait briefly for the mint to see the payment.
    let paid = quote;
    for (let i = 0; i < 30 && paid.state !== 'PAID'; i++) {
      await new Promise((r) => setTimeout(r, 500));
      paid = await wallet.checkMintQuoteBolt11(quote.quote);
    }
    if (paid.state !== 'PAID') {
      throw new Error(`the mint never confirmed payment (quote=${quote.quote}, state=${paid.state})`);
    }

    const proofs = await wallet.mintProofsBolt11(amount, quote.quote);
    await this.mutate(async (state) => {
      bucket(state, mint).proofs.push(...normalizeProofs(proofs));
      state.topUps.push({ at: now, sats: amount });
    });
    return true;
  }

  // ─── spend ──────────────────────────────────────────────────────

  /**
   * Build an envelope worth `amountSats`.
   *
   * A shortfall triggers one top-up attempt; still short and it throws
   * `InsufficientFloatError`. The resulting token is recorded as **pending** — never
   * discarded just because the relay did not answer.
   */
  async spend(
    mint: string,
    amountSats: number,
    ctx: { eventId: string; relayUrl: string },
  ): Promise<PaymentEnvelope> {
    let have = (await this.balance())[mint] ?? 0;
    // NaN makes `NaN < x` false, which skips the top-up and fails silently. An unreadable
    // balance is worse than an empty one, so stop loudly.
    if (!Number.isFinite(have)) {
      throw new Error(
        `cannot read the balance for ${mint} (NaN). Stored proof amounts may be malformed.`,
      );
    }
    if (have < amountSats) {
      await this.topUp(mint);
      have = (await this.balance())[mint] ?? 0;
      if (have < amountSats) throw new InsufficientFloatError(mint, amountSats, have);
    }

    const { Wallet, getEncodedToken } = await cashu();
    const wallet = new Wallet(mint);
    await wallet.loadMint();

    return this.mutate(async (state) => {
      const b = bucket(state, mint);
      // Split at the mint to hit exactly `amountSats`; `send` hands back the change.
      const { keep, send } = await wallet.send(amountSats, b.proofs);
      const token = getEncodedToken({ mint, unit: 'sat', proofs: send });

      b.proofs = normalizeProofs(keep) as Proof[];
      state.spends ??= [];
      state.spends.push({
        at: Date.now(),
        mint,
        sats: amountSats,
        eventId: ctx.eventId,
        relayUrl: ctx.relayUrl,
      });
      // Keep only recent entries. This is for display, not accounting.
      if (state.spends.length > 500) state.spends = state.spends.slice(-500);
      b.pending.push({
        token,
        proofs: normalizeProofs(send) as Proof[],
        eventId: ctx.eventId,
        relayUrl: ctx.relayUrl,
        at: Date.now(),
      });
      return { v: 1, method: 'cashu', mint, unit: 'sat', token } satisfies PaymentEnvelope;
    });
  }

  /** Spend history, for display. */
  async spendHistory(): Promise<SpendRecord[]> {
    const state = await this.loadState();
    return state.spends ?? [];
  }

  /** Refund history. */
  async refundHistory(): Promise<RefundRecord[]> {
    const state = await this.loadState();
    return state.refunds ?? [];
  }

  /** Top-up history. */
  async topUpHistory(): Promise<{ at: number; sats: number }[]> {
    const state = await this.loadState();
    return state.topUps;
  }

  /** The relay definitely took it; drop the pending entry. */
  async settle(eventId: string): Promise<void> {
    await this.mutate(async (state) => {
      for (const b of Object.values(state.mints)) {
        b.pending = b.pending.filter((p) => p.eventId !== eventId);
      }
    });
  }

  /**
   * Reconcile pending payments (PLAN §6, pending-proof GC).
   *
   * Tokens we never got an answer for are checked against the mint (NUT-07 checkstate):
   * **unspent ones come back**, spent ones are dropped. Without this, ecash in the
   * "did it go through?" state is stuck forever.
   */
  async reconcile(olderThanMs = 60_000): Promise<{ recovered: number; spent: number }> {
    const cutoff = Date.now() - olderThanMs;
    const state = await this.loadState();
    let recovered = 0;
    let spent = 0;

    for (const [mint, b] of Object.entries(state.mints)) {
      const stale = b.pending.filter((p) => p.at < cutoff);
      if (stale.length === 0) continue;

      const { Wallet } = await cashu();
      const wallet = new Wallet(mint);
      await wallet.loadMint();

      for (const p of stale) {
        let unspent: boolean;
        try {
          const states = await wallet.checkProofsStates(p.proofs);
          unspent = states.every((s) => s.state === 'UNSPENT');
        } catch {
          continue; // could not ask the mint: hold, never discard
        }
        await this.mutate(async (s) => {
          const bb = bucket(s, mint);
          bb.pending = bb.pending.filter((x) => x.token !== p.token);
          if (unspent) bb.proofs.push(...normalizeProofs(p.proofs));
        });
        if (unspent) recovered += sats(p.proofs);
        else spent += sats(p.proofs);
      }
    }
    return { recovered, spent };
  }

  // ─── sweep back ─────────────────────────────────────────────────

  /**
   * Sweep remaining ecash to a **lightning address** (LUD-16 → NUT-05 melt).
   *
   * Better than `makeInvoice`: melt needs a fixed-amount invoice, but the right amount is
   * only known after quoting. A lightning address lets **us** choose the amount and converge.
 *
   * Pending entries are left alone — run `reconcile()` first.
   */
  async refundToLightningAddress(
    address: string,
  ): Promise<{ mint: string; sentSats: number; feeSats: number }[]> {
    const params = await resolveLightningAddress(address);
    const state = await this.loadState();
    const out: { mint: string; sentSats: number; feeSats: number }[] = [];

    for (const [mint, b] of Object.entries(state.mints)) {
      const total = sats(b.proofs);
      if (total < 2) continue; // not even enough for the fee

      const { Wallet } = await cashu();
      const wallet = new Wallet(mint);
      await wallet.loadMint();

      const found = await findAffordableAmount(total, async (send) => {
        const invoice = await requestInvoice(params, send);
        const quote = await wallet.createMeltQuoteBolt11(invoice);
        const needed = Number(quote.amount) + Number(quote.fee_reserve ?? 0);
        return { neededSats: needed, quote };
      });
      if (!found) continue;

      const quote = found.quote as Awaited<ReturnType<typeof wallet.createMeltQuoteBolt11>>;
      const { keep, send } = await wallet.send(found.neededSats, b.proofs);
      const res = await wallet.meltProofsBolt11(quote, send);

      // NUT-08: the unused fee reserve comes back as change. Dropping it is a straight loss.
      const change = (res as { change?: Proof[] }).change ?? [];
      await this.mutate(async (s) => {
        const bb = bucket(s, mint);
        bb.proofs = normalizeProofs([...(keep as Proof[]), ...change]) as Proof[];
      });

      const record: RefundRecord = {
        at: Date.now(),
        mint,
        sentSats: found.sendSats,
        feeSats: found.neededSats - found.sendSats - sats(change),
        target: address,
      };
      await this.mutate(async (s) => {
        s.refunds ??= [];
        s.refunds.push(record);
      });
      out.push({ mint: record.mint, sentSats: record.sentSats, feeSats: record.feeSats });
    }
    return out;
  }

  /**
   * Work out **how much can be sent** without melting anything.
   *
   * Answers "what size invoice clears the balance?" — melt reserves a fee, so sending the
   * full total fails and the user has no way to know what to subtract. With a lightning
   * address we can mint invoices and quote against them.
   */
  async estimateRefund(
    address: string,
  ): Promise<{ mint: string; totalSats: number; sendSats: number; feeSats: number }[]> {
    const params = await resolveLightningAddress(address);
    const state = await this.loadState();
    const out: { mint: string; totalSats: number; sendSats: number; feeSats: number }[] = [];

    for (const [mint, b] of Object.entries(state.mints)) {
      const total = sats(b.proofs);
      if (total < 2) continue;
      const { Wallet } = await cashu();
      const wallet = new Wallet(mint);
      await wallet.loadMint();
      const found = await findAffordableAmount(total, async (send) => {
        const invoice = await requestInvoice(params, send);
        const quote = await wallet.createMeltQuoteBolt11(invoice);
        return {
          neededSats: Number(quote.amount) + Number(quote.fee_reserve ?? 0),
          quote,
        };
      });
      if (!found) continue;
      out.push({
        mint,
        totalSats: total,
        sendSats: found.sendSats,
        feeSats: found.neededSats - found.sendSats,
      });
    }
    return out;
  }

  /**
   * Sweep to an invoice the wallet produces (NUT-05 melt → `funding.makeInvoice`).
   *
   * We cannot choose the amount here, so `refundToLightningAddress` is preferable.
   * Pending entries are left alone — run `reconcile()` first.
   */
  async refundAll(): Promise<{ mint: string; sats: number }[]> {
    if (!this.opts.funding.makeInvoice) {
      throw new Error('sweeping requires funding.makeInvoice');
    }
    const state = await this.loadState();
    const out: { mint: string; sats: number }[] = [];

    for (const [mint, b] of Object.entries(state.mints)) {
      const total = sats(b.proofs);
      if (total <= 1) continue; // too small to cover a fee; leave it

      const { Wallet } = await cashu();
      const wallet = new Wallet(mint);
      await wallet.loadMint();

      // Leave room for the lightning fee; the remainder waits for the next sweep.
      const invoice = await this.opts.funding.makeInvoice!(total - 1);
      const quote = await wallet.createMeltQuoteBolt11(invoice);
      const needed = Number(quote.amount) + Number(quote.fee_reserve ?? 0);
      if (needed > total) continue;

      const { keep, send } = await wallet.send(needed, b.proofs);
      await wallet.meltProofsBolt11(quote, send);

      await this.mutate(async (s) => {
        bucket(s, mint).proofs = normalizeProofs(keep) as Proof[];
      });
      out.push({ mint, sats: Number(quote.amount) });
    }
    return out;
  }
}

// Assembly: predicate, ledger and collector wired in the order PLAN §3.4 requires.
//
// **Hook-agnostic** — it imports nothing from `@nostr-relay/*`, so it drops onto any relay
// implementation and unit tests run without one. Adapting to a specific hook is a thin
// adapter's job.

import {
  okInProgress,
  okPaymentInvalid,
  okPaymentRequired,
  okRefund,
  priceFor,
  type NostrEventLike,
  type PaymentEnvelope,
  type PaymentTerms,
} from '@nostr-paywall/protocol';
import type { Collector } from '@nostr-paywall/collectors';
import type { PaymentRepository } from './repository.js';

export type GuardOutcome =
  /** Not chargeable. Just store it. */
  | { kind: 'free' }
  /** Already paid for. Store it, charge nothing. */
  | { kind: 'already-paid' }
  /**
   * Collected; safe to store. If storage fails, `refundToken` must be returned —
   * see `onStorageFailed()`.
   */
  | { kind: 'collected'; amountMsat: number; refundToken: string | null }
  /** Rejected. Put `okMessage` straight into `["OK", id, false, …]`. */
  | { kind: 'reject'; okMessage: string };

export interface PaymentGuardOptions {
  /** This relay's policy. Must be the **same object** the NIP-11 document uses, or they drift. */
  terms: PaymentTerms;
  collectors: readonly Collector[];
  repository: PaymentRepository;
  /**
   * The human sentence carried by `payment-required`.
   * Ordinary clients show it in a toast, so it must make manual recovery possible.
   */
  humanPrice?: string;
}

export class PaymentGuard {
  private readonly terms: PaymentTerms;
  private readonly repo: PaymentRepository;
  private readonly byMethod: Map<string, Collector>;
  private readonly humanPrice: string;

  constructor(opts: PaymentGuardOptions) {
    this.terms = opts.terms;
    this.repo = opts.repository;
    this.byMethod = new Map(opts.collectors.map((c) => [c.method, c]));
    this.humanPrice = opts.humanPrice ?? '1 sat per tagged note';
  }

  /** Boot gate: if any collector fails to init, the relay must not start. */
  async init(): Promise<void> {
    await Promise.all([...this.byMethod.values()].map((c) => c.init()));
  }

  /**
   * Decide whether the event may be stored, collecting payment if required.
   *
   * The ordering is the safeguard (PLAN §3.4): money is touched **only after every other
   * rejection reason has passed**. The caller must already have checked signature, size and
   * duplication before getting here.
   */
  async check(
    event: NostrEventLike,
    envelope: PaymentEnvelope | null,
  ): Promise<GuardOutcome> {
    const price = priceFor(event, this.terms);
    if (!price.charge) return { kind: 'free' };

    if (envelope === null) {
      return { kind: 'reject', okMessage: okPaymentRequired(this.humanPrice) };
    }

    const collector = this.byMethod.get(envelope.method);
    if (!collector) {
      return {
        kind: 'reject',
        okMessage: okPaymentInvalid(`unsupported payment method: ${envelope.method}`),
      };
    }

    const ctx = { eventId: event.id, priceMsat: price.amountMsat };

    // ── gate: nothing moves ──
    const valid = await collector.validate(envelope, ctx);
    if (!valid.ok) return { kind: 'reject', okMessage: okPaymentInvalid(valid.reason) };

    // ── reserve: double-spend and idempotency ──
    const reserved = await this.repo.reserve(event.id, collector.method, valid.refs);
    switch (reserved.kind) {
      case 'already-paid':
        // Also catches a client that lost its envelope and retried with fresh proofs.
        return { kind: 'already-paid' };
      case 'in-progress':
        return { kind: 'reject', okMessage: okInProgress() };
      case 'conflict':
        return {
          kind: 'reject',
          okMessage: okPaymentInvalid('these ecash proofs were already used for another event'),
        };
      case 'reserved':
        break;
    }

    // ── collect: money moves from here ──
    let collected;
    try {
      collected = await collector.collect(envelope, ctx);
    } catch (e) {
      const reason = (e as Error).message;
      await this.repo.fail(event.id, reason);
      return { kind: 'reject', okMessage: okPaymentInvalid(reason) };
    }

    // ── record: failing here means money taken with no ledger entry ──
    try {
      await this.repo.commit(event.id, collected.amountMsat, collected.proofs);
    } catch (e) {
      // We cannot claim success. Hand back what we are holding, immediately.
      if (collected.refundToken) {
        return { kind: 'reject', okMessage: okRefund(collected.refundToken, 'ledger write failed') };
      }
      // Not even a refund token. Swallowing this loses the user money with no explanation.
      return {
        kind: 'reject',
        okMessage: okPaymentInvalid(
          `payment collected but could not be recorded or refunded: ${(e as Error).message}`,
        ),
      };
    }

    return {
      kind: 'collected',
      amountMsat: collected.amountMsat,
      refundToken: collected.refundToken,
    };
  }

  /**
   * Call after `check` returned `collected` and **storage then failed**.
   *
   * Without this path PLAN §3.4 step 7 is words only — money taken, no event.
   * Returns the OK message to send.
   */
  async onStorageFailed(eventId: string, refundToken: string | null): Promise<string> {
    await this.repo.fail(eventId, 'storage failed after collection');
    if (refundToken) return okRefund(refundToken);
    // The proofs remain in the ledger, so manual recovery is possible. Be honest about it.
    return okPaymentInvalid('storage failed and the refund token could not be encoded');
  }
}

// 조립 — 술어·원장·collector 를 PLAN §3.4 의 순서대로 엮는다.
//
// **훅 비의존**이다. `@nostr-relay/*` 를 import 하지 않으므로 어느 릴레이 구현에도 얹을 수 있고,
// 유닛 테스트도 릴레이 없이 돈다. 특정 훅에 맞추는 건 얇은 어댑터(`plugin.ts`) 몫.

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
  /** 과금 대상이 아니다. 그냥 저장하면 된다. */
  | { kind: 'free' }
  /** 이미 낸 이벤트다. 재과금 없이 저장하면 된다. */
  | { kind: 'already-paid' }
  /**
   * 수납 완료. 저장해도 된다.
   * 저장이 실패하면 `refundToken` 을 돌려줘야 한다 — `onStorageFailed()` 참조.
   */
  | { kind: 'collected'; amountMsat: number; refundToken: string | null }
  /** 거절. `okMessage` 를 그대로 `["OK", id, false, …]` 에 실으면 된다. */
  | { kind: 'reject'; okMessage: string };

export interface PaymentGuardOptions {
  /** 이 릴레이의 정책. NIP-11 문서에 싣는 것과 **같은 객체**여야 갈리지 않는다. */
  terms: PaymentTerms;
  collectors: readonly Collector[];
  repository: PaymentRepository;
  /**
   * `payment-required` 에 실을 사람용 문장.
   * 일반 클라는 이 문자열을 에러 토스트에 그대로 띄우므로 수동 대응이 가능해야 한다.
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

  /** 부팅 게이트. collector 하나라도 실패하면 릴레이를 띄우지 않는다. */
  async init(): Promise<void> {
    await Promise.all([...this.byMethod.values()].map((c) => c.init()));
  }

  /**
   * 이벤트를 저장해도 되는지 판정하고, 필요하면 수납한다.
   *
   * 순서가 곧 안전장치다(§3.4) — 돈은 **다른 모든 거부 사유를 통과한 뒤에만** 건드린다.
   * 호출자는 이 함수 앞에서 서명·크기·중복 검증을 이미 끝냈어야 한다.
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

    // ── 관문: 돈을 건드리지 않는다 ──
    const valid = await collector.validate(envelope, ctx);
    if (!valid.ok) return { kind: 'reject', okMessage: okPaymentInvalid(valid.reason) };

    // ── 선점: 이중사용·멱등 판정 ──
    const reserved = await this.repo.reserve(event.id, collector.method, valid.refs);
    switch (reserved.kind) {
      case 'already-paid':
        // 클라가 봉투를 잃고 새 proofs 로 재시도한 경우까지 여기서 잡힌다.
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

    // ── 수납: 여기부터 돈이 움직인다 ──
    let collected;
    try {
      collected = await collector.collect(envelope, ctx);
    } catch (e) {
      const reason = (e as Error).message;
      await this.repo.fail(event.id, reason);
      return { kind: 'reject', okMessage: okPaymentInvalid(reason) };
    }

    // ── 기록: 여기 실패하면 돈은 받았는데 장부가 없다 ──
    try {
      await this.repo.commit(event.id, collected.amountMsat, collected.proofs);
    } catch (e) {
      // 성공이라 우길 수 없다. 손에 있는 걸 즉시 돌려준다.
      if (collected.refundToken) {
        return { kind: 'reject', okMessage: okRefund(collected.refundToken, 'ledger write failed') };
      }
      // 환불 토큰조차 못 만든 경우. 삼키면 유저는 영문도 모르고 잃는다.
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
   * `check` 가 `collected` 를 준 뒤 **저장이 실패했을 때** 부른다.
   *
   * 이 경로가 없으면 §3.4-7 이 말뿐이 된다 — 돈은 받고 이벤트는 없는 상태로 끝난다.
   * 반환값은 클라에 보낼 OK 메시지.
   */
  async onStorageFailed(eventId: string, refundToken: string | null): Promise<string> {
    await this.repo.fail(eventId, 'storage failed after collection');
    if (refundToken) return okRefund(refundToken);
    // 원물은 원장에 남아 있으므로 수동 회수는 가능하다. 유저에게는 정직하게 알린다.
    return okPaymentInvalid('storage failed and the refund token could not be encoded');
  }
}

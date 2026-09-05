// collector 계약. **실제로 돈을 만지는 유일한 층**이다.
//
// `validate` 와 `collect` 를 나누는 게 핵심이다 — PLAN §3.4 의 처리 순서가 여기서 나온다.
// validate 는 돈을 건드리지 않으므로 릴레이가 "결제 외 모든 거부 사유"를 먼저 걸러낼 수 있고,
// collect 는 그 관문을 통과한 뒤에만 불린다.

import type { PaymentEnvelope } from '@nostr-paywall/protocol';

export interface CollectContext {
  /** 이 결제가 사려는 이벤트. 멱등 판정에 쓴다(§3.6). */
  eventId: string;
  /** 술어가 계산한 가격. */
  priceMsat: number;
}

export type ValidateResult =
  | {
      ok: true;
      /**
       * 이중사용 판정 키. 릴레이 DB 의 UNIQUE 대상이자 멱등 조회 키다.
       * Cashu 는 입력 proof 의 `secret` 들.
       */
      refs: string[];
      /** 이 봉투가 실제로 담고 있는 금액. */
      amountMsat: number;
    }
  | {
      ok: false;
      /**
       * OK 메시지에 그대로 실릴 **사람이 읽을 문장**.
       * 일반 클라는 이 문자열을 에러 토스트에 띄우므로 수동 대응이 가능해야 한다.
       */
      reason: string;
    };

export interface CollectResult {
  refs: string[];
  /** 수수료 차감 후 **실제로 우리 것이 된** 금액. */
  amountMsat: number;
  /**
   * 수납한 원물. **릴레이가 반드시 영구 저장해야 한다** —
   * 안 하면 재시작 한 번에 걷은 ecash 를 전부 잃는다. 베어러라 복구 수단이 없다.
   */
  proofs: unknown[];
  /**
   * 저장 실패 시 되돌려줄 토큰(갓 swap 한 proofs 를 인코딩).
   *
   * collect 가 이걸 같이 내주므로 별도 `refund()` 메서드가 필요 없다 —
   * 반환할 물건은 수납 시점에 이미 손에 있다.
   *
   * **인코딩이 실패하면 `null`.** 여기서 던지면 이미 돈을 받은 뒤에 터지는 꼴이라
   * §3.4 의 7단계(환불)가 통째로 무력해진다. 인코딩은 실패해도 `proofs` 는 남으므로
   * 릴레이는 최소한 기록은 남기고 수동 회수를 할 수 있다.
   */
  refundToken: string | null;
}

export interface Collector {
  /** 봉투의 `method` 와 일치해야 한다. */
  readonly method: string;

  /** 부팅 게이트. 민트 정책 확인 등. 실패하면 릴레이를 띄우지 않는다. */
  init(): Promise<void>;

  /** **돈을 건드리지 않는다.** 모양·정책·금액만 본다. */
  validate(envelope: PaymentEnvelope, ctx: CollectContext): Promise<ValidateResult>;

  /** 실제 수납. validate 가 ok 를 준 봉투에만 부른다. */
  collect(envelope: PaymentEnvelope, ctx: CollectContext): Promise<CollectResult>;
}

import type {
  NostrEventLike,
  PaymentEnvelope,
  PaymentTerms,
} from '@nostr-paywall/protocol';

export interface PaymentRequest {
  relayUrl: string;
  /** 서명 완료된 이벤트. `id` 가 확정돼 있다. */
  event: NostrEventLike;
  /** 릴레이가 NIP-11 로 광고한 조건. 금액·수단·민트가 여기 있다. */
  terms: PaymentTerms;
  /** 이 이벤트에 대해 릴레이가 요구하는 금액. */
  amountMsat: number;
}

/**
 * 결제 능력 주입점.
 *
 * nostr-tools 가 NIP-42 를 푼 방식(`automaticallyAuth`)을 그대로 베꼈다 —
 * 서명키가 앱에 있듯 지갑도 앱에 있고, 풀은 콜백만 받는다.
 *
 * 릴레이 URL 을 받아 `null`(이 릴레이엔 돈 안 냄) 또는 결제 함수를 돌려준다.
 * 결제 함수가 `null` 을 돌려주면 그 건은 포기한다(예산 초과·사용자 거부).
 */
export type Payer = (
  relayUrl: string,
) => null | ((req: PaymentRequest) => Promise<PaymentEnvelope | null>);

/**
 * 지불 수단이 없거나 거부돼서 발행하지 못했다.
 *
 * **일반 네트워크 오류와 반드시 구별돼야 한다.** 우리 설계상 유료 릴레이는 하필
 * 답글 상대의 inbox 릴레이라, 이걸 뭉개면 "답글이 상대에게 전달 안 됐는데
 * UI 는 성공"이라는 조용한 실패가 된다(PLAN §6.6a).
 */
export class PaymentUnavailableError extends Error {
  readonly name = 'PaymentUnavailableError';
  constructor(
    readonly relayUrl: string,
    readonly reason: 'no-payer' | 'declined' | 'failed' | 'unsupported',
    message: string,
  ) {
    super(message);
  }
}

/** 릴레이별 학습 결과. */
export type RelayPolicy =
  /** 아직 모른다. 일단 표준 2원소로 보내본다. */
  | { kind: 'unknown' }
  /** 무료 릴레이. 봉투를 붙이지 않는다. */
  | { kind: 'free' }
  /** 유료. `terms` 로 로컬 판정이 가능해져 1-shot 발행이 된다. */
  | { kind: 'paid'; terms: PaymentTerms; learnedAt: number };

/** 정책 캐시를 앱이 영속화하고 싶을 때. 안 주면 메모리에만 둔다. */
export interface PolicyStore {
  load(): Record<string, RelayPolicy> | Promise<Record<string, RelayPolicy>>;
  save(policies: Record<string, RelayPolicy>): void | Promise<void>;
}

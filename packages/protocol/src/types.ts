// 프로토콜 전역 타입. 런타임 의존성 0 — 릴레이(node)와 클라(브라우저) 양쪽에서 그대로 쓴다.
// nostr-tools를 import 하지 않는 이유: 이 패키지를 릴레이가 쓸 때 클라용 의존성을 끌고 오지 않기 위해.

/** 우리가 실제로 읽는 필드만. nostr-tools의 `Event`와 구조적으로 호환된다. */
export interface NostrEventLike {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

// ─── terms (릴레이가 NIP-11로 광고하는 것) ──────────────────────────

/**
 * NIP-11 `fees.publication[]` 한 항목.
 *
 * `tags`는 우리 확장이다. 바닐라 NIP-11은 kind로만 대상을 표현할 수 있어서
 * "남에게 노티가 가는 이벤트만"을 못 쓴다. 의미: `kind ∈ kinds` **AND**
 * `tags` 중 하나라도 이벤트에 존재. `tags` 생략 시 kind만 본다(하위호환).
 */
export interface PublicationRule {
  kinds: number[];
  /** 태그 *이름* 목록. 대소문자 구분(= "e" ≠ "E"). 생략 시 kind만 판정. */
  tags?: string[];
  /** `unit` 기준 금액. 정규화된 값은 `ChargeDecision.amountMsat`를 쓸 것. */
  amount: number;
  unit: string;
}

export interface CashuMethod {
  type: 'cashu';
  unit: string;
  /** 릴레이가 상환 가능한 민트 allowlist. 클라는 이 중에서만 골라야 한다. */
  mints: string[];
}

export interface LnKeysendMethod {
  type: 'ln-keysend';
  unit: string;
  /** 릴레이 LN 노드 펍키. preimage 파생에 들어간다(§3.7). */
  node: string;
}

/** 우리가 모르는 수단도 버리지 않고 들고 있는다 — 클라가 "지원 안 함"을 구별하게. */
export interface UnknownMethod {
  type: string;
  [k: string]: unknown;
}

export type PaymentMethod = CashuMethod | LnKeysendMethod | UnknownMethod;

export interface PaymentTerms {
  rules: PublicationRule[];
  methods: PaymentMethod[];
  /** 릴레이가 3원소 `["EVENT", event, payment]`를 받는가. false면 1-shot 불가. */
  envelopeInEventMessage: boolean;
}

// ─── payment 봉투 (EVENT 메시지의 3번째 원소) ────────────────────────
//
// 서명 이벤트가 아니라 평범한 JSON이다 — 연결할 키가 없어서 익명성이 유지되고 코드도 준다.

export const ENVELOPE_VERSION = 1;

export interface CashuEnvelope {
  v: number;
  method: 'cashu';
  mint: string;
  unit: string;
  /**
   * **인코딩된 NUT-00 토큰 문자열**(`cashuB…`). raw proof 배열이 아니다.
   *
   * 배열로 실으면 릴레이 쪽 swap 이 입력 0개로 조립돼 실패한다 — v2 keyset 의 짧은 id
   * 해석이 토큰 디코딩 과정에서 일어나기 때문(실측: `Inputs: 0, Outputs: 0`).
   * 문자열이라 JSON 왕복에도 무손실이고, proof 의 `amount` 가 cashu-ts v4 에서
   * `Amount` 클래스(bigint 래퍼)라 직렬화하면 숫자가 문자열로 변하는 함정도 피한다.
   *
   * **unlocked** — P2PK로 잠그지 않는다(PLAN D5).
   */
  token: string;
}

export interface LnKeysendEnvelope {
  v: number;
  method: 'ln-keysend';
  node: string;
  /** `HMAC(client_secret, event_id ‖ node)`의 hex. 저장하지 않고 파생한다(§3.7). */
  nonce: string;
}

export type PaymentEnvelope = CashuEnvelope | LnKeysendEnvelope;

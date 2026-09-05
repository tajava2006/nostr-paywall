// 과금 술어 — 이 파일이 릴레이와 클라의 **유일한 공유 진실**이다.
//
// 두 벌로 구현하면 반드시 갈린다: 클라는 공짜라고 믿고 2원소로 보내는데 릴레이는
// 과금이라 거부하는 식으로. 그래서 판정은 여기 한 곳에만 있고, 정책 자체는
// 코드가 아니라 릴레이가 광고한 `terms`에 들어 있다(클라는 *릴레이의* 정책을 평가한다).

import { toMsat } from './terms.js';
import type { NostrEventLike, PaymentTerms, PublicationRule } from './types.js';

export type ChargeDecision =
  | { charge: false }
  | { charge: true; amountMsat: number; rule: PublicationRule };

const FREE: ChargeDecision = { charge: false };

/** 이벤트에 주어진 이름의 태그가 하나라도 있는가. 태그 이름은 대소문자를 구분한다. */
function hasAnyTag(event: NostrEventLike, names: readonly string[]): boolean {
  if (!Array.isArray(event.tags)) return false;
  for (const tag of event.tags) {
    // NIP-01상 태그는 문자열 1개 이상이지만, 남이 만든 이벤트라 방어적으로 본다.
    if (!Array.isArray(tag) || tag.length === 0) continue;
    const name = tag[0];
    if (typeof name === 'string' && names.includes(name)) return true;
  }
  return false;
}

function matches(event: NostrEventLike, rule: PublicationRule): boolean {
  if (!rule.kinds.includes(event.kind)) return false;
  // tags 생략 = kind만으로 판정(바닐라 NIP-11 하위호환).
  if (rule.tags === undefined) return true;
  return hasAnyTag(event, rule.tags);
}

/**
 * 이 이벤트를 이 릴레이에 발행할 때 얼마를 내야 하는가.
 *
 * 규칙은 **first match wins**. 어디에도 안 걸리면 무료.
 * `terms`가 없으면(= 유료 릴레이가 아니거나 아직 학습 전) 무료로 본다.
 */
export function priceFor(
  event: NostrEventLike,
  terms: PaymentTerms | null | undefined,
): ChargeDecision {
  if (!terms) return FREE;
  for (const rule of terms.rules) {
    if (!matches(event, rule)) continue;
    const amountMsat = toMsat(rule.amount, rule.unit);
    // 파서가 걸렀어야 하지만, terms를 손으로 만든 호출자도 있을 수 있다.
    if (amountMsat === null) continue;
    if (amountMsat === 0) return FREE; // 0으로 광고한 kind는 목록에만 있고 실과금 없음
    return { charge: true, amountMsat, rule };
  }
  return FREE;
}

/** `priceFor(...).charge`의 축약. 1-shot 발행 여부 판정에 쓴다. */
export function shouldCharge(
  event: NostrEventLike,
  terms: PaymentTerms | null | undefined,
): boolean {
  return priceFor(event, terms).charge;
}

// ─── v1 기본 정책 ────────────────────────────────────────────────
//
// 릴레이가 자기 NIP-11 문서를 만들 때 이걸 씨앗으로 쓴다. 문서와 코드가 갈리지 않도록
// 숫자는 여기 한 곳에만 둔다.

/**
 * 과금 대상 kind. **allowlist**인 이유: 모르는 kind는 공짜(fail-open)라
 * 예외 목록보다 짧고, kind 3·10002·30000번대의 구조적 `p` 태그가 자동으로 빠진다.
 * 대가는 스팸이 새 kind로 이주할 수 있다는 것 — 주기적 갱신이 유지보수 항목이다.
 *
 * - 1     답글/멘션 (NIP-10: 답글은 부모의 p 태그를 전부 물려받는다)
 * - 4     레거시 DM
 * - 6, 16 리포스트 (NIP-18: e+p로 노티 + 팔로워 피드 자동 렌더)
 * - 7     리액션 (NIP-25). NIP-30이 kind 7에 커스텀 이모지를 허용 →
 *         `<image-url>`이 임의 URL이라 공격자 이미지가 상대 알림에 렌더된다
 * - 1111  코멘트 (NIP-22)
 * - 1059  gift wrap (NIP-17) — 구독 모델이 원리적으로 못 푸는 바로 그 케이스
 */
export const V1_CHARGED_KINDS: readonly number[] = [1, 4, 6, 7, 16, 1111, 1059];

/**
 * 과금을 유발하는 태그. 소문자만 본다.
 *
 * `q`(인용) 제외: 인용당한 사람은 알지도 못하고, 자동 렌더는 *인용한 사람의*
 * 팔로워 피드에서 일어난다. 주의력 절도가 아니다.
 * NIP-22의 대문자 `E`/`P`(루트 스코프)도 제외: 부모가 nostr 이벤트면 소문자
 * `e`/`p`가 항상 같이 붙고, 웹URL·팟캐스트 코멘트는 `I`/`i`뿐이라 아무도 노티를
 * 안 받으므로 무료가 맞다.
 */
export const V1_CHARGED_TAGS: readonly string[] = ['e', 'p'];

/** v1 일괄가: 1 sat. kind별 차등·수신자별 가격은 v2. */
export const V1_PRICE_MSAT = 1000;

export function defaultRules(priceMsat: number = V1_PRICE_MSAT): PublicationRule[] {
  return [
    {
      kinds: [...V1_CHARGED_KINDS],
      tags: [...V1_CHARGED_TAGS],
      amount: priceMsat,
      unit: 'msats',
    },
  ];
}

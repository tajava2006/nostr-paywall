// OK 응답의 조립(릴레이)과 해석(클라).
//
// 양쪽을 한 파일에 두는 이유: 접두사 문자열이 두 벌이 되면 조용히 갈린다.
// 릴레이가 "payment-required:"를 보내는데 클라가 "payment_required:"를 찾는 식으로.

// ─── 접두사 ──────────────────────────────────────────────────────
//
// NIP-01의 표준 접두사 8종(duplicate/pow/blocked/rate-limited/invalid/restricted/mute/error)에
// payment 관련이 없다. 우리 클라가 소비자라 새 접두사를 쓰되, **사람이 읽을 문장을 반드시**
// 붙인다 — 일반 클라는 이 문자열을 에러 토스트에 그대로 띄우므로 수동 결제 폴백이 공짜로 생긴다.

export const PREFIX_PAYMENT_REQUIRED = 'payment-required';
export const PREFIX_PAYMENT_INVALID = 'payment-invalid';
export const PREFIX_DUPLICATE = 'duplicate';
export const PREFIX_ERROR = 'error';
/** NIP-01 표준 접두사. 재시도해도 되는 거절에 쓴다. */
export const PREFIX_RATE_LIMITED = 'rate-limited';

/** 저장 실패로 수납한 돈을 돌려줄 때 쓰는 키. OK 메시지가 유일한 반환 채널이다. */
export const REFUND_KEY = 'refund=';

// ─── 릴레이: 조립 ────────────────────────────────────────────────

export function okPaymentRequired(humanReason: string): string {
  return `${PREFIX_PAYMENT_REQUIRED}: ${humanReason}`;
}

export function okPaymentInvalid(humanReason: string): string {
  return `${PREFIX_PAYMENT_INVALID}: ${humanReason}`;
}

export function okDuplicate(): string {
  return `${PREFIX_DUPLICATE}: already have this event`;
}

/**
 * 같은 이벤트의 결제가 이미 처리 중일 때.
 *
 * `payment-invalid` 를 쓰면 안 된다 — 그건 "이 봉투로 재시도하지 마라"는 뜻인데
 * 여기선 봉투에 아무 문제가 없다. 잠시 후 재시도가 맞으므로 `rate-limited` 다.
 */
export function okInProgress(): string {
  return `${PREFIX_RATE_LIMITED}: payment for this event is already in progress`;
}

/**
 * 수납 후 저장에 실패했을 때. 토큰을 반드시 실어 보낸다.
 *
 * 이 경로가 존재하는 이유는 PLAN §3.4의 순서 때문이다 — 결제 외 모든 거부 사유를
 * 먼저 검사하므로, 수납 뒤에 남는 실패는 인프라 장애뿐이고 그건 여기서 덮는다.
 */
export function okRefund(token: string, humanReason = 'storage failed'): string {
  return `${PREFIX_ERROR}: ${humanReason}; ${REFUND_KEY}${token}`;
}

// ─── 클라: 해석 ──────────────────────────────────────────────────

export type OkOutcome =
  /** 저장됨. */
  | { kind: 'accepted' }
  /** 이미 있음 — 무과금 통과. 재시도의 정상 종착지다. */
  | { kind: 'duplicate' }
  /** 결제 필요. terms를 아직 모르면 NIP-11을 lazy fetch 할 신호(PLAN D8). */
  | { kind: 'payment-required'; message: string }
  /** 봉투가 거부됨(이중사용·민트 불허·형식). 같은 봉투로 재시도하면 안 된다. */
  | { kind: 'payment-invalid'; message: string }
  /** 수납됐지만 저장 실패. `token`을 반드시 회수할 것. */
  | { kind: 'refunded'; token: string; message: string }
  /** 그 밖의 거부. */
  | { kind: 'rejected'; prefix: string; message: string };

function splitPrefix(reason: string): { prefix: string; rest: string } {
  const i = reason.indexOf(':');
  if (i < 0) return { prefix: '', rest: reason.trim() };
  return { prefix: reason.slice(0, i).trim(), rest: reason.slice(i + 1).trim() };
}

/** 환불 토큰을 뽑는다. `refund=<token>` — 토큰은 공백 없는 문자열이다. */
export function extractRefundToken(reason: string): string | null {
  const at = reason.indexOf(REFUND_KEY);
  if (at < 0) return null;
  const token = reason.slice(at + REFUND_KEY.length).trim().split(/\s/)[0];
  return token !== undefined && token.length > 0 ? token : null;
}

/**
 * `["OK", <id>, <accepted>, <reason>]`의 뒤쪽 두 값을 해석한다.
 *
 * nostr-tools의 `publish()`는 성공 시 reason 문자열로 resolve 하고 실패 시
 * `new Error(reason)`으로 reject 하므로(abstract-relay.ts), 래퍼는 양쪽에서
 * 이 함수를 그대로 부르면 된다.
 */
export function parseOkReason(accepted: boolean, reason: string): OkOutcome {
  const { prefix, rest } = splitPrefix(reason ?? '');

  if (accepted) {
    // 수락 시에도 접두사가 붙을 수 있다 (NIP-01의 `duplicate:` 예시).
    return prefix === PREFIX_DUPLICATE ? { kind: 'duplicate' } : { kind: 'accepted' };
  }

  // 환불은 접두사보다 우선한다 — 돈이 딸려 오는 응답을 일반 오류로 흘리면 그대로 잃는다.
  const token = extractRefundToken(reason);
  if (token !== null) {
    // `message` 는 사람에게 보여줄 문장이다. 기계용 토큰 절은 잘라낸다.
    const cut = rest.indexOf(REFUND_KEY);
    const message = (cut < 0 ? rest : rest.slice(0, cut)).replace(/[\s;]+$/, '');
    return { kind: 'refunded', token, message };
  }

  switch (prefix) {
    case PREFIX_PAYMENT_REQUIRED:
      return { kind: 'payment-required', message: rest };
    case PREFIX_PAYMENT_INVALID:
      return { kind: 'payment-invalid', message: rest };
    default:
      return { kind: 'rejected', prefix, message: rest };
  }
}

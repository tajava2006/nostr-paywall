// NIP-11 릴레이 정보 문서 → PaymentTerms.
//
// 입력은 **신뢰할 수 없는 원격 JSON**이다. 어떤 모양이 와도 throw 하지 않고,
// 이해 못 한 부분은 조용히 버린다(fail-open = 그 이벤트는 무료로 취급).
// 유료 판정을 못 해서 공짜로 보내는 건 안전하지만, 파서가 터져서 발행이 막히면 안 된다.

import type {
  PaymentMethod,
  PaymentTerms,
  PublicationRule,
} from './types.js';

// ─── unit 정규화 ─────────────────────────────────────────────────
//
// NIP-11 예시는 "msats"를 쓰지만 실물 릴레이는 "sats"도 쓴다. msat으로 통일한다.

const UNIT_TO_MSAT: Record<string, number> = {
  msat: 1,
  msats: 1,
  millisat: 1,
  millisats: 1,
  sat: 1000,
  sats: 1000,
};

/** 모르는 단위면 null — 호출자가 "판정 불가"로 처리하게 한다(0으로 뭉개지 않는다). */
export function toMsat(amount: number, unit: string): number | null {
  if (!Number.isFinite(amount) || amount < 0) return null;
  const mul = UNIT_TO_MSAT[unit.toLowerCase()];
  if (mul === undefined) return null;
  return amount * mul;
}

// ─── 파싱 ────────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function stringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === 'string' && x.length > 0);
  return out.length > 0 ? out : undefined;
}

function parseRule(v: unknown): PublicationRule | null {
  if (!isRecord(v)) return null;

  // kinds 가 없거나 비면 규칙을 불활성으로 본다. 바닐라 NIP-11은 kinds 생략을
  // "전 kind"로 읽을 여지가 있지만, 그렇게 해석하면 릴레이의 오타 하나가
  // 모든 이벤트를 유료로 만든다. 돈이 걸린 방향은 항상 fail-open 으로 간다.
  const kinds = Array.isArray(v['kinds'])
    ? v['kinds'].filter((k): k is number => typeof k === 'number' && Number.isInteger(k))
    : [];
  if (kinds.length === 0) return null;

  const amount = v['amount'];
  const unit = v['unit'];
  if (typeof amount !== 'number' || typeof unit !== 'string') return null;
  if (toMsat(amount, unit) === null) return null; // 모르는 단위 → 규칙 폐기

  const tags = stringArray(v['tags']);
  return tags ? { kinds, tags, amount, unit } : { kinds, amount, unit };
}

function parseMethod(v: unknown): PaymentMethod | null {
  if (!isRecord(v)) return null;
  const type = v['type'];
  if (typeof type !== 'string' || type.length === 0) return null;
  const unit = typeof v['unit'] === 'string' ? v['unit'] : 'sat';

  if (type === 'cashu') {
    const mints = stringArray(v['mints']);
    if (!mints) return null; // 민트 목록 없는 cashu 수단은 쓸 수 없다
    return { type: 'cashu', unit, mints };
  }
  if (type === 'ln-keysend') {
    const node = v['node'];
    if (typeof node !== 'string' || node.length === 0) return null;
    return { type: 'ln-keysend', unit, node };
  }
  // 모르는 수단은 그대로 보존 — 클라가 "지원 안 함"을 구별해 사용자에게 알릴 수 있게.
  return { ...v, type } as PaymentMethod;
}

/**
 * NIP-11 문서에서 결제 조건을 뽑는다.
 *
 * 유료 릴레이가 아니거나 조건을 하나도 못 읽으면 `null`.
 * 발견 경로는 "거부당한 뒤 lazy fetch"다(PLAN D8) — 선제적으로 읽는 클라는 없다.
 */
export function parsePaymentTerms(info: unknown): PaymentTerms | null {
  if (!isRecord(info)) return null;

  const fees = info['fees'];
  const publication = isRecord(fees) ? fees['publication'] : undefined;
  const rules = Array.isArray(publication)
    ? publication.map(parseRule).filter((r): r is PublicationRule => r !== null)
    : [];
  if (rules.length === 0) return null; // 과금 규칙이 없으면 유료 릴레이로 취급하지 않는다

  const pv = info['payment_v1'];
  const methods =
    isRecord(pv) && Array.isArray(pv['methods'])
      ? pv['methods'].map(parseMethod).filter((m): m is PaymentMethod => m !== null)
      : [];

  // 명시 안 하면 false. 3원소 EVENT는 비표준이라 "지원한다"고 광고한 릴레이에만 보낸다.
  const envelopeInEventMessage =
    isRecord(pv) && pv['envelope_in_event_message'] === true;

  return { rules, methods, envelopeInEventMessage };
}

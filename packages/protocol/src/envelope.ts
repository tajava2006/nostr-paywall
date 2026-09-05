// payment 봉투의 모양 검증. **암호 검증은 여기 없다** — 그건 레일별 collector 소관.
//
// 릴레이 처리 순서(PLAN §3.4)에서 이 파일은 4단계(형식 검증)를 담당한다.
// 5단계(swap/정산 = 실제 수납)로 넘어가기 전에 걸러야 할 것만 본다.

import { ENVELOPE_VERSION } from './types.js';
import type { CashuEnvelope, LnKeysendEnvelope, PaymentEnvelope } from './types.js';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * 봉투를 파싱한다. 모양이 안 맞으면 `null`.
 *
 * 릴레이가 받는 값이라 **신뢰할 수 없는 입력**이다. 여기서 throw 하면
 * 연결 하나가 죽으므로 절대 던지지 않는다.
 */
export function parsePaymentEnvelope(v: unknown): PaymentEnvelope | null {
  if (!isRecord(v)) return null;
  if (v['v'] !== ENVELOPE_VERSION) return null;

  const method = v['method'];
  if (method === 'cashu') {
    const mint = v['mint'];
    const proofs = v['proofs'];
    if (typeof mint !== 'string' || mint.length === 0) return null;
    if (!Array.isArray(proofs) || proofs.length === 0) return null;
    const unit = typeof v['unit'] === 'string' ? v['unit'] : 'sat';
    return { v: ENVELOPE_VERSION, method: 'cashu', mint, unit, proofs } satisfies CashuEnvelope;
  }

  if (method === 'ln-keysend') {
    const node = v['node'];
    const nonce = v['nonce'];
    if (typeof node !== 'string' || node.length === 0) return null;
    // 넌스는 파생값(§3.7)이라 항상 32바이트 hex다. 형식을 강제해 두면
    // 릴레이가 preimage를 계산하기 전에 쓰레기를 거를 수 있다.
    if (typeof nonce !== 'string' || !HEX64.test(nonce)) return null;
    return { v: ENVELOPE_VERSION, method: 'ln-keysend', node, nonce } satisfies LnKeysendEnvelope;
  }

  return null;
}

/**
 * 봉투가 릴레이의 민트 allowlist 안에 있는가 (PLAN §4.1 H1).
 *
 * P2PK를 기각한 뒤에도 이 검사만은 남는다 — 이유가 다르기 때문이다.
 * P2PK 방어가 아니라 **"우리가 상환할 수 있는 민트여야 한다"**는 경제적 요건.
 */
export function isMintAllowed(envelope: PaymentEnvelope, allowedMints: readonly string[]): boolean {
  if (envelope.method !== 'cashu') return true;
  return allowedMints.includes(envelope.mint);
}

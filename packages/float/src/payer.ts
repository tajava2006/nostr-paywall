// float → `Payer` 어댑터. 앱이 실제로 쓰는 진입점이다.

import type { Payer, PaymentRequest } from '@nostr-paywall/client';
import type { PaymentEnvelope, PaymentTerms } from '@nostr-paywall/protocol';
import type { EcashFloat } from './float.js';

/**
 * 릴레이가 광고한 수단 중 우리가 쓸 민트를 고른다.
 *
 * `allowedMints` 를 주면 그 교집합에서만 고른다 — 앱이 신뢰하는 민트를 제한하는
 * 자리다. 릴레이가 부르는 대로 아무 민트나 쓰면 안 된다(그 민트에 돈을 맡기는 것이므로).
 */
export function pickMint(
  terms: PaymentTerms,
  allowedMints?: readonly string[],
): string | null {
  for (const m of terms.methods) {
    if (m.type !== 'cashu') continue;
    const mints = (m as { mints?: unknown }).mints;
    if (!Array.isArray(mints)) continue;
    for (const mint of mints) {
      if (typeof mint !== 'string') continue;
      if (!allowedMints || allowedMints.includes(mint)) return mint;
    }
  }
  return null;
}

export interface FloatPayerOptions {
  /** 앱이 신뢰하는 민트. 생략하면 릴레이가 광고한 것을 그대로 쓴다. */
  allowedMints?: readonly string[];
  /** 릴레이별로 낼지 말지. 생략하면 전부 낸다. */
  shouldPay?: (relayUrl: string) => boolean;
  onError?: (e: unknown, req: PaymentRequest) => void;
}

/**
 * `PaidPool({ payer })` 에 그대로 꽂는다.
 *
 * ```ts
 * const float = new EcashFloat({ store, funding });
 * const pool = new PaidPool({ payer: createFloatPayer(float) });
 * ```
 *
 * 실패하면 `null` 을 돌려준다 — 풀이 `PaymentUnavailableError(declined)` 로 바꿔
 * 앱에 알린다. 여기서 던지면 원인 구별이 흐려진다.
 */
export function createFloatPayer(float: EcashFloat, opts: FloatPayerOptions = {}): Payer {
  return (relayUrl: string) => {
    if (opts.shouldPay && !opts.shouldPay(relayUrl)) return null;

    return async (req: PaymentRequest): Promise<PaymentEnvelope | null> => {
      const mint = pickMint(req.terms, opts.allowedMints);
      if (!mint) return null; // 우리가 쓸 수 있는 민트를 릴레이가 안 받는다

      // 릴레이 가격은 msat 이지만 Cashu sat 키셋은 정수 sat 만 표현한다.
      // 모자라게 내면 거부되므로 올림한다.
      const amountSats = Math.ceil(req.amountMsat / 1000);

      try {
        return await float.spend(mint, amountSats, {
          eventId: req.event.id,
          relayUrl: req.relayUrl,
        });
      } catch (e) {
        opts.onError?.(e, req);
        return null;
      }
    };
  };
}

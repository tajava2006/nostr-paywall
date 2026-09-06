// 민트 수수료 게이트 — 1 sat 가격의 생사가 걸린 로직이라 숫자를 못박는다.
// 근거는 NUT-02: fees = ceil(sum(input_fee_ppk)/1000), sum(inputs) - fees == sum(outputs).

import { describe, expect, it } from 'vitest';
import {
  assertZeroFeeMints,
  feeForInputs,
  fetchMintFeePolicy,
  maxActiveInputFeePpk,
  type FetchLike,
} from '../src/mint-policy.js';

const fakeFetch = (byMint: Record<string, unknown>): FetchLike => {
  return async (url: string) => {
    const mint = url.replace('/v1/keysets', '');
    const body = byMint[mint];
    if (body === undefined) throw new Error(`민트 없음: ${mint}`);
    return { json: async () => body };
  };
};

describe('feeForInputs (NUT-02)', () => {
  it('ppk=100 이면 입력 1~10개가 1 sat, 11~20개가 2 sat — 02.md:33 의 예시', () => {
    expect(feeForInputs(1, 100)).toBe(1);
    expect(feeForInputs(3, 100)).toBe(1);
    expect(feeForInputs(10, 100)).toBe(1);
    expect(feeForInputs(11, 100)).toBe(2);
    expect(feeForInputs(20, 100)).toBe(2);
  });

  it('ppk=0 이면 항상 0 — 이게 1 sat 결제의 전제다', () => {
    expect(feeForInputs(1, 0)).toBe(0);
    expect(feeForInputs(1000, 0)).toBe(0);
  });

  it('ppk=100 에서 1 sat 은 원리적으로 불가능하다 (수수료가 원금 이상)', () => {
    const inputs = 1;
    const gross = 1;
    expect(gross - feeForInputs(inputs, 100)).toBe(0); // 출력 0 → swap 성립 안 함
    expect(gross - feeForInputs(inputs, 0)).toBe(1); // ppk=0 이면 그대로 통과
  });
});

describe('maxActiveInputFeePpk', () => {
  const ks = (o: Partial<{ id: string; unit: string; active: boolean; input_fee_ppk: number }>) => ({
    id: o.id ?? 'k',
    unit: o.unit ?? 'sat',
    active: o.active ?? true,
    ...(o.input_fee_ppk !== undefined ? { input_fee_ppk: o.input_fee_ppk } : {}),
  });

  it('활성 sat 키셋 중 최댓값을 쓴다 — 클라가 어느 키셋을 쓸지 우리가 못 고르므로 최악값', () => {
    expect(maxActiveInputFeePpk([ks({ input_fee_ppk: 0 }), ks({ input_fee_ppk: 100 })])).toBe(100);
  });

  it('비활성 키셋과 다른 unit 은 무시', () => {
    expect(
      maxActiveInputFeePpk([
        ks({ input_fee_ppk: 0 }),
        ks({ input_fee_ppk: 100, active: false }),
        ks({ input_fee_ppk: 100, unit: 'usd' }),
      ]),
    ).toBe(0);
  });

  it('input_fee_ppk 생략은 0 으로 본다', () => {
    expect(maxActiveInputFeePpk([ks({})])).toBe(0);
  });

  it('해당 unit 의 활성 키셋이 없으면 null — 판정 불가는 통과가 아니다', () => {
    expect(maxActiveInputFeePpk([])).toBeNull();
    expect(maxActiveInputFeePpk([ks({ active: false })])).toBeNull();
  });
});

describe('부팅 게이트', () => {
  const good = 'https://good.mint';
  const bad = 'https://bad.mint';
  const f = fakeFetch({
    [good]: { keysets: [{ id: 'a', unit: 'sat', active: true, input_fee_ppk: 0 }] },
    [bad]: { keysets: [{ id: 'b', unit: 'sat', active: true, input_fee_ppk: 100 }] },
  });

  it('ppk=0 민트는 통과', async () => {
    await expect(assertZeroFeeMints([good], 'sat', f)).resolves.toHaveLength(1);
  });

  it('ppk≠0 민트가 하나라도 있으면 던진다 — 릴레이를 못 띄우게 하는 게 맞다', async () => {
    await expect(assertZeroFeeMints([good, bad], 'sat', f)).rejects.toThrow(/input_fee_ppk=100/);
  });

  it('allowlist 가 비면 던진다', async () => {
    await expect(assertZeroFeeMints([], 'sat', f)).rejects.toThrow(/allowlist is empty/);
  });

  it('trailing slash 를 정규화한다', async () => {
    const p = await fetchMintFeePolicy(`${good}///`, 'sat', f);
    expect(p.zeroFee).toBe(true);
  });
});

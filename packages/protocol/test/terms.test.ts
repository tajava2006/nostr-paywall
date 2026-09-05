// NIP-11 파서 테스트. 입력은 신뢰할 수 없는 원격 JSON이라
// "어떤 쓰레기가 와도 throw 하지 않는다"가 제일 중요한 성질이다.

import { describe, expect, it } from 'vitest';
import { parsePaymentTerms, toMsat } from '../src/terms.js';

const full = {
  name: 'paywalled relay',
  limitation: { restricted_writes: true },
  fees: {
    publication: [
      { kinds: [1, 4, 6, 7, 16, 1111, 1059], tags: ['e', 'p'], amount: 1000, unit: 'msats' },
    ],
  },
  payment_v1: {
    envelope_in_event_message: true,
    methods: [
      { type: 'cashu', unit: 'sat', mints: ['https://mint.example.com'] },
      { type: 'ln-keysend', unit: 'msat', node: '03deadbeef' },
    ],
  },
};

describe('parsePaymentTerms', () => {
  it('완전한 문서를 읽는다', () => {
    const t = parsePaymentTerms(full);
    expect(t).not.toBeNull();
    expect(t!.rules).toHaveLength(1);
    expect(t!.rules[0]!.tags).toEqual(['e', 'p']);
    expect(t!.methods).toHaveLength(2);
    expect(t!.envelopeInEventMessage).toBe(true);
  });

  it('fees.publication 이 없으면 유료 릴레이로 보지 않는다', () => {
    expect(parsePaymentTerms({ name: 'free relay' })).toBeNull();
    expect(parsePaymentTerms({ fees: {} })).toBeNull();
    expect(parsePaymentTerms({ fees: { admission: [{ amount: 1, unit: 'sats' }] } })).toBeNull();
  });

  it('envelope_in_event_message 기본값은 false — 3원소는 비표준이라 광고한 릴레이에만 보낸다', () => {
    const t = parsePaymentTerms({ fees: { publication: [{ kinds: [1], amount: 1, unit: 'sats' }] } });
    expect(t!.envelopeInEventMessage).toBe(false);
  });

  it('kinds 가 비면 규칙을 버린다 — 릴레이 오타가 전 이벤트를 유료로 만들면 안 된다', () => {
    expect(parsePaymentTerms({ fees: { publication: [{ amount: 1, unit: 'sats' }] } })).toBeNull();
    expect(
      parsePaymentTerms({ fees: { publication: [{ kinds: [], amount: 1, unit: 'sats' }] } }),
    ).toBeNull();
  });

  it('모르는 단위의 규칙은 버린다 — 0 으로 뭉개지 않는다', () => {
    const t = parsePaymentTerms({
      fees: {
        publication: [
          { kinds: [1], amount: 1, unit: 'dogecoin' },
          { kinds: [4], amount: 2, unit: 'sats' },
        ],
      },
    });
    expect(t!.rules).toHaveLength(1);
    expect(t!.rules[0]!.kinds).toEqual([4]);
  });

  it('민트 목록 없는 cashu 수단은 버린다', () => {
    const t = parsePaymentTerms({
      ...full,
      payment_v1: { methods: [{ type: 'cashu', unit: 'sat' }] },
    });
    expect(t!.methods).toHaveLength(0);
  });

  it('모르는 수단은 보존한다 — 클라가 "지원 안 함"을 구별해 알릴 수 있게', () => {
    const t = parsePaymentTerms({
      ...full,
      payment_v1: { methods: [{ type: 'ark', unit: 'sat', server: 'https://ark' }] },
    });
    expect(t!.methods).toHaveLength(1);
    expect(t!.methods[0]!.type).toBe('ark');
  });

  it('쓰레기 입력에 throw 하지 않는다', () => {
    for (const junk of [null, undefined, 42, 'nope', [], { fees: 'no' }, { fees: { publication: 'no' } }]) {
      expect(() => parsePaymentTerms(junk)).not.toThrow();
      expect(parsePaymentTerms(junk)).toBeNull();
    }
  });

  it('규칙 배열 안의 쓰레기 항목만 골라 버린다', () => {
    const t = parsePaymentTerms({
      fees: { publication: [null, 'x', { kinds: [1], amount: 1, unit: 'sats' }, {}] },
    });
    expect(t!.rules).toHaveLength(1);
  });
});

describe('toMsat', () => {
  it('sat/msat 계열을 정규화한다', () => {
    expect(toMsat(1, 'sats')).toBe(1000);
    expect(toMsat(1, 'sat')).toBe(1000);
    expect(toMsat(1000, 'msats')).toBe(1000);
    expect(toMsat(1000, 'MSATS')).toBe(1000);
  });

  it('모르는 단위·음수·NaN 은 null', () => {
    expect(toMsat(1, 'usd')).toBeNull();
    expect(toMsat(-1, 'sats')).toBeNull();
    expect(toMsat(Number.NaN, 'sats')).toBeNull();
  });
});

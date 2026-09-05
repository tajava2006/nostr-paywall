import { describe, expect, it } from 'vitest';
import { parsePaymentEnvelope, isMintAllowed } from '../src/envelope.js';
import { encodeEventMessage, spliceEnvelope, takePaymentEnvelope } from '../src/message.js';
import type { CashuEnvelope, LnKeysendEnvelope, NostrEventLike } from '../src/types.js';

const event: NostrEventLike = {
  id: 'a'.repeat(64),
  pubkey: 'b'.repeat(64),
  created_at: 1_700_000_000,
  kind: 1,
  tags: [['p', 'c'.repeat(64)]],
  content: 'hi',
  sig: 'd'.repeat(128),
};

const cashu: CashuEnvelope = {
  v: 1,
  method: 'cashu',
  mint: 'https://mint.example.com',
  unit: 'sat',
  proofs: [{ id: '009a1f29', amount: 1, secret: 's', C: '02ab' }],
};

const keysend: LnKeysendEnvelope = {
  v: 1,
  method: 'ln-keysend',
  node: '03deadbeef',
  nonce: 'e'.repeat(64),
};

describe('parsePaymentEnvelope', () => {
  it('정상 봉투를 읽는다', () => {
    expect(parsePaymentEnvelope(cashu)).toEqual(cashu);
    expect(parsePaymentEnvelope(keysend)).toEqual(keysend);
  });

  it('unit 을 생략하면 sat', () => {
    const { unit, ...noUnit } = cashu;
    expect(parsePaymentEnvelope(noUnit)?.method === 'cashu' && parsePaymentEnvelope(noUnit)).toMatchObject({ unit: 'sat' });
  });

  it('버전이 다르면 거부', () => {
    expect(parsePaymentEnvelope({ ...cashu, v: 2 })).toBeNull();
    expect(parsePaymentEnvelope({ ...cashu, v: undefined })).toBeNull();
  });

  it('proofs 가 비면 거부', () => {
    expect(parsePaymentEnvelope({ ...cashu, proofs: [] })).toBeNull();
    expect(parsePaymentEnvelope({ ...cashu, proofs: 'nope' })).toBeNull();
  });

  it('넌스가 32바이트 hex 가 아니면 거부 — 파생값이라 형식이 고정이다', () => {
    expect(parsePaymentEnvelope({ ...keysend, nonce: 'short' })).toBeNull();
    expect(parsePaymentEnvelope({ ...keysend, nonce: 'E'.repeat(64) })).toBeNull(); // 대문자 hex 불가
    expect(parsePaymentEnvelope({ ...keysend, nonce: 'g'.repeat(64) })).toBeNull();
  });

  it('모르는 method·쓰레기는 null, throw 하지 않는다', () => {
    for (const junk of [null, undefined, 1, 'x', [], { v: 1, method: 'ark' }]) {
      expect(() => parsePaymentEnvelope(junk)).not.toThrow();
      expect(parsePaymentEnvelope(junk)).toBeNull();
    }
  });
});

describe('isMintAllowed (H1)', () => {
  it('allowlist 밖 민트는 거부', () => {
    expect(isMintAllowed(cashu, ['https://mint.example.com'])).toBe(true);
    expect(isMintAllowed(cashu, ['https://other.mint'])).toBe(false);
    expect(isMintAllowed(cashu, [])).toBe(false);
  });

  it('cashu 가 아니면 해당 없음', () => {
    expect(isMintAllowed(keysend, [])).toBe(true);
  });
});

describe('EVENT 메시지 조립', () => {
  it('봉투 없으면 표준 2원소 — 비유료 릴레이엔 이게 나가야 생태계 무영향', () => {
    const msg = encodeEventMessage(event);
    expect(JSON.parse(msg)).toEqual(['EVENT', event]);
  });

  it('봉투가 있으면 3원소', () => {
    const msg = encodeEventMessage(event, cashu);
    expect(JSON.parse(msg)).toEqual(['EVENT', event, cashu]);
  });

  it('spliceEnvelope 는 nostr-tools 가 만든 문자열에서 같은 결과를 낸다', () => {
    // abstract-relay.ts:360 의 하드코딩 형태를 그대로 재현
    const fromNostrTools = '["EVENT",' + JSON.stringify(event) + ']';
    expect(spliceEnvelope(fromNostrTools, cashu)).toBe(encodeEventMessage(event, cashu));
  });

  it('EVENT 가 아닌 메시지는 손대지 않는다 — 여기서 망가뜨리면 REQ/AUTH 까지 깨진다', () => {
    const req = '["REQ","sub1",{"kinds":[1]}]';
    expect(spliceEnvelope(req, cashu)).toBe(req);
    const auth = '["AUTH",{"kind":22242}]';
    expect(spliceEnvelope(auth, cashu)).toBe(auth);
  });
});

describe('takePaymentEnvelope (릴레이 진입점)', () => {
  it('2원소는 그대로, 봉투는 null', () => {
    const r = takePaymentEnvelope(['EVENT', event]);
    expect(r!.message).toEqual(['EVENT', event]);
    expect(r!.envelope).toBeNull();
  });

  it('3원소는 봉투를 떼고 2원소를 돌려준다 — validator 가 여분 원소를 거부하므로', () => {
    const r = takePaymentEnvelope(['EVENT', event, cashu]);
    expect(r!.message).toHaveLength(2);
    expect(r!.message).toEqual(['EVENT', event]);
    expect(r!.envelope).toEqual(cashu);
  });

  it('봉투가 깨져도 메시지는 통과시킨다 — 그래야 payment-required 라는 정확한 이유로 거부된다', () => {
    const r = takePaymentEnvelope(['EVENT', event, { garbage: true }]);
    expect(r!.message).toEqual(['EVENT', event]);
    expect(r!.envelope).toBeNull();
  });

  it('EVENT 가 아니면 null — 호출자가 원본을 그대로 흘려보내게', () => {
    expect(takePaymentEnvelope(['REQ', 'sub1', {}])).toBeNull();
    expect(takePaymentEnvelope('not an array')).toBeNull();
    expect(takePaymentEnvelope(null)).toBeNull();
  });

  it('원본 배열을 변형하지 않는다', () => {
    const data = ['EVENT', event, cashu];
    takePaymentEnvelope(data);
    expect(data).toHaveLength(3);
  });
});

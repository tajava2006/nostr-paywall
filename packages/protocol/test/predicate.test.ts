// 과금 술어 테스트.
//
// 여기 있는 케이스는 대부분 설계 단계에서 **논쟁 끝에 정한 것들**이다.
// 나중에 누가 술어를 건드려서 이 결정을 되돌리면 여기서 터져야 한다.

import { describe, expect, it } from 'vitest';
import { defaultRules, priceFor, shouldCharge, V1_PRICE_MSAT } from '../src/predicate.js';
import type { NostrEventLike, PaymentTerms } from '../src/types.js';

const terms: PaymentTerms = {
  rules: defaultRules(),
  methods: [],
  envelopeInEventMessage: true,
};

function ev(kind: number, tags: string[][]): NostrEventLike {
  return { id: 'x', pubkey: 'y', created_at: 0, kind, tags, content: '', sig: 'z' };
}

describe('과금 대상', () => {
  it('답글(kind 1 + e) 은 과금', () => {
    expect(shouldCharge(ev(1, [['e', 'root', '', 'root']]), terms)).toBe(true);
  });

  it('멘션(kind 1 + p) 은 과금', () => {
    expect(shouldCharge(ev(1, [['p', 'someone']]), terms)).toBe(true);
  });

  it('gift wrap(1059 + p) 은 과금 — 구독 모델이 원리적으로 못 푸는 케이스', () => {
    expect(shouldCharge(ev(1059, [['p', 'recipient']]), terms)).toBe(true);
  });

  it('리액션(7 + e + p) 은 과금 — NIP-30 커스텀 이모지로 임의 이미지가 알림에 렌더된다', () => {
    expect(shouldCharge(ev(7, [['e', 'target'], ['p', 'author']]), terms)).toBe(true);
  });

  it('리포스트(6·16) 는 과금', () => {
    expect(shouldCharge(ev(6, [['e', 't'], ['p', 'a']]), terms)).toBe(true);
    expect(shouldCharge(ev(16, [['e', 't'], ['p', 'a'], ['k', '30023']]), terms)).toBe(true);
  });

  it('레거시 DM(4 + p) 은 과금', () => {
    expect(shouldCharge(ev(4, [['p', 'recipient']]), terms)).toBe(true);
  });

  it('가격은 v1 일괄 1 sat', () => {
    const d = priceFor(ev(1, [['p', 'x']]), terms);
    expect(d.charge).toBe(true);
    if (d.charge) expect(d.amountMsat).toBe(V1_PRICE_MSAT);
  });
});

describe('무과금 — 설계 결정이 걸린 것들', () => {
  it('플레인 노트는 무료 — 아무도 안 보는 글은 스팸이 될 수 없다', () => {
    expect(shouldCharge(ev(1, []), terms)).toBe(false);
    expect(shouldCharge(ev(1, [['t', 'bitcoin']]), terms)).toBe(false);
  });

  it('q 단독 인용은 무료 — 인용당한 사람은 알지도 못한다', () => {
    expect(shouldCharge(ev(1, [['q', 'quoted-id', '', 'author']]), terms)).toBe(false);
  });

  it('팔로우 리스트(kind 3)는 p 태그가 수백 개여도 무료 — 구조적 태그지 노티가 아니다', () => {
    const many = Array.from({ length: 300 }, (_, i) => ['p', `pubkey-${i}`]);
    expect(shouldCharge(ev(3, many), terms)).toBe(false);
  });

  it('릴레이 리스트(10002)·팔로우 셋(30000)도 무료', () => {
    expect(shouldCharge(ev(10002, [['r', 'wss://x']]), terms)).toBe(false);
    expect(shouldCharge(ev(30000, [['d', 'set'], ['p', 'a']]), terms)).toBe(false);
  });

  it('NIP-22 웹URL 코멘트는 무료 — I/K/i/k 뿐이라 아무도 노티를 안 받는다', () => {
    // 22.md의 실제 예시 모양
    const webComment = ev(1111, [
      ['I', 'https://abc.com/articles/1'],
      ['K', 'web'],
      ['i', 'https://abc.com/articles/1'],
      ['k', 'web'],
    ]);
    expect(shouldCharge(webComment, terms)).toBe(false);
  });

  it('NIP-22 이벤트 코멘트는 과금 — 부모가 nostr 이벤트면 소문자 e/p 가 붙는다', () => {
    const eventComment = ev(1111, [
      ['E', 'root-id', 'wss://r', 'root-pubkey'],
      ['K', '1063'],
      ['P', 'root-pubkey'],
      ['e', 'parent-id', 'wss://r', 'parent-pubkey'],
      ['k', '1111'],
      ['p', 'parent-pubkey'],
    ]);
    expect(shouldCharge(eventComment, terms)).toBe(true);
  });

  it('대문자 E/P 단독은 무료 — 태그 이름은 대소문자를 구분한다', () => {
    expect(shouldCharge(ev(1111, [['E', 'root'], ['P', 'author'], ['K', '1']]), terms)).toBe(false);
  });

  it('allowlist 밖 kind 는 p 태그가 있어도 무료 (fail-open)', () => {
    expect(shouldCharge(ev(30023, [['p', 'a'], ['e', 'b']]), terms)).toBe(false);
    expect(shouldCharge(ev(9735, [['p', 'a'], ['e', 'b']]), terms)).toBe(false); // zap receipt
  });

  it('terms 가 없으면 무료 (유료 릴레이가 아니거나 아직 학습 전)', () => {
    expect(shouldCharge(ev(1, [['p', 'a']]), null)).toBe(false);
    expect(shouldCharge(ev(1, [['p', 'a']]), undefined)).toBe(false);
  });
});

describe('규칙 평가', () => {
  it('가격 0 인 kind 는 목록에 있어도 실과금 없음 — v2 차등가용 노브', () => {
    const zero: PaymentTerms = {
      rules: [{ kinds: [7], tags: ['e', 'p'], amount: 0, unit: 'msats' }, ...defaultRules()],
      methods: [],
      envelopeInEventMessage: true,
    };
    expect(shouldCharge(ev(7, [['e', 'a'], ['p', 'b']]), zero)).toBe(false);
    expect(shouldCharge(ev(1, [['p', 'b']]), zero)).toBe(true);
  });

  it('first match wins', () => {
    const t: PaymentTerms = {
      rules: [
        { kinds: [1], tags: ['p'], amount: 5, unit: 'sats' },
        { kinds: [1], tags: ['p'], amount: 99, unit: 'sats' },
      ],
      methods: [],
      envelopeInEventMessage: true,
    };
    const d = priceFor(ev(1, [['p', 'a']]), t);
    expect(d.charge && d.amountMsat).toBe(5000);
  });

  it('tags 생략 규칙은 kind 만으로 판정 (바닐라 NIP-11 하위호환)', () => {
    const t: PaymentTerms = {
      rules: [{ kinds: [4], amount: 100, unit: 'msats' }],
      methods: [],
      envelopeInEventMessage: false,
    };
    expect(shouldCharge(ev(4, []), t)).toBe(true);
  });

  it('망가진 태그 배열에도 안 터진다 (남이 만든 이벤트다)', () => {
    const broken = { ...ev(1, []), tags: [[], ['p'], null, 'nope'] } as unknown as NostrEventLike;
    expect(() => shouldCharge(broken, terms)).not.toThrow();
    expect(shouldCharge(broken, terms)).toBe(true); // ['p'] 는 이름만 있어도 유효한 태그
  });
});

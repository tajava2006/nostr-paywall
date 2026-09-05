// 조립 테스트 — **순서가 곧 안전장치**라는 §3.4 의 주장을 실제로 못박는다.
// 특히 "돈은 다른 모든 거부 사유를 통과한 뒤에만 움직인다"를 호출 추적으로 확인한다.

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  defaultRules,
  parseOkReason,
  type NostrEventLike,
  type PaymentEnvelope,
  type PaymentTerms,
} from '@nostr-paywall/protocol';
import type { Collector } from '@nostr-paywall/collectors';
import { PaymentGuard } from '../src/guard.js';
import { SqlitePaymentRepository } from '../src/sqlite-repository.js';

const terms: PaymentTerms = {
  rules: defaultRules(),
  methods: [],
  envelopeInEventMessage: true,
};

const charged: NostrEventLike = {
  id: 'a'.repeat(64),
  pubkey: 'b'.repeat(64),
  created_at: 0,
  kind: 1,
  tags: [['p', 'c'.repeat(64)]], // p 태그 → 과금 대상
  content: 'reply',
  sig: 'd'.repeat(128),
};
const free: NostrEventLike = { ...charged, id: 'f'.repeat(64), tags: [] };

const envelope: PaymentEnvelope = {
  v: 1,
  method: 'cashu',
  mint: 'https://mint',
  unit: 'sat',
  token: 'cashuBtoken',
};

let repo: SqlitePaymentRepository | undefined;
afterEach(() => {
  repo?.close();
  repo = undefined;
});

function fakeCollector(over: Partial<Collector> = {}): Collector {
  return {
    method: 'cashu',
    init: async () => {},
    validate: async () => ({ ok: true, refs: ['s1'], amountMsat: 1000 }),
    collect: async () => ({
      refs: ['s1'],
      amountMsat: 1000,
      proofs: [{ amount: 1, secret: 'fresh' }],
      refundToken: 'cashuBrefund',
    }),
    ...over,
  };
}

function guard(collector = fakeCollector()) {
  repo = new SqlitePaymentRepository(':memory:');
  return new PaymentGuard({ terms, collectors: [collector], repository: repo });
}

describe('과금 대상 판정', () => {
  it('과금 대상이 아니면 봉투 없이도 통과 — 읽기·플레인 노트는 무료다', async () => {
    const collect = vi.fn();
    const g = guard(fakeCollector({ collect: collect as never }));
    expect(await g.check(free, null)).toEqual({ kind: 'free' });
    expect(collect).not.toHaveBeenCalled();
  });

  it('과금 대상인데 봉투가 없으면 payment-required + 사람이 읽을 문장', async () => {
    const g = guard();
    const out = await g.check(charged, null);
    expect(out.kind).toBe('reject');
    if (out.kind !== 'reject') return;
    const parsed = parseOkReason(false, out.okMessage);
    expect(parsed.kind).toBe('payment-required');
    if (parsed.kind === 'payment-required') expect(parsed.message).toMatch(/sat/);
  });
});

describe('순서 — 돈은 마지막에 움직인다 (§3.4)', () => {
  it('validate 가 거부하면 collect 를 부르지 않는다', async () => {
    const collect = vi.fn();
    const g = guard(
      fakeCollector({
        validate: async () => ({ ok: false, reason: 'mint not allowed: https://evil' }),
        collect: collect as never,
      }),
    );
    const out = await g.check(charged, envelope);
    expect(collect).not.toHaveBeenCalled();
    expect(out.kind).toBe('reject');
    if (out.kind === 'reject') {
      expect(parseOkReason(false, out.okMessage).kind).toBe('payment-invalid');
    }
  });

  it('이중사용(conflict)이면 collect 를 부르지 않는다', async () => {
    const collect = vi.fn(fakeCollector().collect);
    const g = guard(fakeCollector({ collect: collect as never }));
    // 다른 이벤트가 먼저 같은 refs 를 선점
    await repo!.reserve('z'.repeat(64), 'cashu', ['s1']);

    const out = await g.check(charged, envelope);
    expect(collect).not.toHaveBeenCalled();
    expect(out.kind).toBe('reject');
    if (out.kind === 'reject') expect(out.okMessage).toMatch(/already used for another event/);
  });

  it('모르는 method 는 관문에서 끊는다', async () => {
    const g = guard();
    const out = await g.check(charged, { ...envelope, method: 'ark' } as never);
    expect(out.kind).toBe('reject');
    if (out.kind === 'reject') expect(out.okMessage).toMatch(/unsupported payment method: ark/);
  });
});

describe('수납', () => {
  it('정상 경로는 수납하고 원장에 자산을 남긴다', async () => {
    const g = guard();
    const out = await g.check(charged, envelope);
    expect(out).toEqual({ kind: 'collected', amountMsat: 1000, refundToken: 'cashuBrefund' });

    const rec = await repo!.find(charged.id);
    expect(rec?.state).toBe('collected');
    expect(rec?.proofs).toEqual([{ amount: 1, secret: 'fresh' }]);
    expect(repo!.totalCollectedMsat()).toBe(1000);
  });

  it('collect 가 터지면 원장에 failed 로 남기고 payment-invalid', async () => {
    const g = guard(
      fakeCollector({
        collect: async () => {
          throw new Error('Token Already Spent');
        },
      }),
    );
    const out = await g.check(charged, envelope);
    expect(out.kind).toBe('reject');
    if (out.kind === 'reject') expect(out.okMessage).toMatch(/Already Spent/);
    expect((await repo!.find(charged.id))?.state).toBe('failed');
  });

  it('이미 낸 이벤트는 재과금 없이 통과 — collect 를 다시 부르지 않는다', async () => {
    const collect = vi.fn(fakeCollector().collect);
    const g = guard(fakeCollector({ collect: collect as never }));
    await g.check(charged, envelope);
    expect(collect).toHaveBeenCalledTimes(1);

    const again = await g.check(charged, envelope);
    expect(again).toEqual({ kind: 'already-paid' });
    expect(collect).toHaveBeenCalledTimes(1); // 두 번째는 안 불렸다
    expect(repo!.totalCollectedMsat()).toBe(1000); // 한 번만 걷혔다
  });
});

describe('돈은 받았는데 실패한 경우', () => {
  it('원장 기록이 실패하면 성공이라 우기지 않고 즉시 환불한다', async () => {
    const g = guard();
    vi.spyOn(repo!, 'commit').mockRejectedValueOnce(new Error('disk full'));

    const out = await g.check(charged, envelope);
    expect(out.kind).toBe('reject');
    if (out.kind !== 'reject') return;
    const parsed = parseOkReason(false, out.okMessage);
    expect(parsed.kind).toBe('refunded');
    if (parsed.kind === 'refunded') expect(parsed.token).toBe('cashuBrefund');
  });

  it('환불 토큰조차 못 만들면 정직하게 알린다 — 삼키면 유저는 영문도 모르고 잃는다', async () => {
    const g = guard(
      fakeCollector({
        collect: async () => ({
          refs: ['s1'],
          amountMsat: 1000,
          proofs: [{ amount: 1 }],
          refundToken: null, // 인코딩 실패
        }),
      }),
    );
    vi.spyOn(repo!, 'commit').mockRejectedValueOnce(new Error('disk full'));

    const out = await g.check(charged, envelope);
    expect(out.kind).toBe('reject');
    if (out.kind === 'reject') expect(out.okMessage).toMatch(/could not be recorded or refunded/);
  });

  it('저장 실패 시 onStorageFailed 가 환불 토큰을 실어 보내고 원장을 failed 로 돌린다', async () => {
    const g = guard();
    const out = await g.check(charged, envelope);
    expect(out.kind).toBe('collected');

    const msg = await g.onStorageFailed(charged.id, 'cashuBrefund');
    const parsed = parseOkReason(false, msg);
    expect(parsed.kind).toBe('refunded');
    expect((await repo!.find(charged.id))?.state).toBe('failed');
  });
});

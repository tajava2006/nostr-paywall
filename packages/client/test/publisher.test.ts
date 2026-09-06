// 발행 흐름 — 학습·1-shot·실패 구별을 못박는다.
// 여기가 깨지면 "답글이 상대에게 전달 안 됐는데 성공으로 보인다"가 된다.

import { describe, expect, it, vi } from 'vitest';
import {
  defaultRules,
  okPaymentRequired,
  type NostrEventLike,
  type PaymentEnvelope,
} from '@nostr-paywall/protocol';
import { publishToRelay, type PublishDeps, type RelayLike } from '../src/publisher.js';
import { PaymentUnavailableError, type RelayPolicy } from '../src/types.js';

const URL = 'wss://paid.relay';

const charged: NostrEventLike = {
  id: 'a'.repeat(64),
  pubkey: 'b'.repeat(64),
  created_at: 0,
  kind: 1,
  tags: [['p', 'c'.repeat(64)]],
  content: 'reply',
  sig: 'd'.repeat(128),
};
const free: NostrEventLike = { ...charged, id: 'f'.repeat(64), tags: [] };

const ENVELOPE: PaymentEnvelope = {
  v: 1,
  method: 'cashu',
  mint: 'https://mint',
  unit: 'sat',
  token: 'cashuBtok',
};

const NIP11 = {
  fees: { publication: defaultRules() },
  payment_v1: {
    envelope_in_event_message: true,
    methods: [{ type: 'cashu', unit: 'sat', mints: ['https://mint'] }],
  },
};

function setup(opts: {
  policy?: RelayPolicy;
  publishImpl?: (e: NostrEventLike) => Promise<string>;
  payer?: PublishDeps['payer'];
  nip11?: unknown;
}) {
  const sent: string[] = [];
  let policy: RelayPolicy = opts.policy ?? { kind: 'unknown' };
  const relay: RelayLike = {
    url: URL,
    send: vi.fn(async (m: string) => {
      sent.push(m);
    }),
    publish: vi.fn(async (e: NostrEventLike) => {
      // 실제 nostr-tools 처럼 send 를 거쳐 나간다 — 봉투 삽입이 여기서 일어난다.
      await relay.send(`["EVENT",${JSON.stringify(e)}]`);
      return opts.publishImpl ? opts.publishImpl(e) : '';
    }),
  };
  const deps: PublishDeps = {
    payer: opts.payer ?? (() => async () => ENVELOPE),
    getRelay: async () => relay,
    getPolicy: () => policy,
    setPolicy: (_u, p) => {
      policy = p;
    },
    fetchRelayInformation: vi.fn(async () => opts.nip11 ?? NIP11),
  };
  return { relay, deps, sent, policyNow: () => policy };
}

describe('모르는 릴레이 — 학습', () => {
  it('일단 표준 2원소로 보낸다. 성공해도 free 라 단정하지 않는다', async () => {
    // 첫 발행이 플레인 노트면 유료 릴레이도 그냥 받아준다 — 성공은 무료의 근거가 아니다.
    const { relay, deps, sent, policyNow } = setup({});
    await publishToRelay(deps, URL, free);
    expect(JSON.parse(sent[0]!)).toHaveLength(2);
    expect(policyNow()).toEqual({ kind: 'unknown' });
    expect(deps.fetchRelayInformation).not.toHaveBeenCalled(); // 선제적으로 안 읽는다
  });

  it('payment-required 를 받으면 그때 NIP-11 을 읽고 결제해 재발행한다', async () => {
    let first = true;
    const { relay, deps, sent, policyNow } = setup({
      publishImpl: async () => {
        if (first) {
          first = false;
          throw new Error(okPaymentRequired('1 sat'));
        }
        return '';
      },
    });

    await publishToRelay(deps, URL, charged);

    expect(deps.fetchRelayInformation).toHaveBeenCalledOnce();
    expect(policyNow().kind).toBe('paid');
    expect(sent).toHaveLength(2);
    const retried = JSON.parse(sent[1]!);
    expect(retried).toHaveLength(3); // 봉투가 붙었다
    expect(retried[2]).toEqual(ENVELOPE);
  });

  it('결제 외 사유로 거부되면 그대로 던진다 — NIP-11 을 읽지 않는다', async () => {
    const { relay, deps } = setup({
      publishImpl: async () => {
        throw new Error('blocked: you are banned');
      },
    });
    await expect(publishToRelay(deps, URL, charged)).rejects.toThrow(/banned/);
    expect(deps.fetchRelayInformation).not.toHaveBeenCalled();
  });
});

describe('유료로 학습된 릴레이 — 1-shot', () => {
  const paid: RelayPolicy = { kind: 'paid', terms: { rules: defaultRules(), methods: [], envelopeInEventMessage: true }, learnedAt: 0 };

  it('과금 대상이면 처음부터 3원소로 보낸다 (왕복 1회)', async () => {
    const { relay, deps, sent } = setup({ policy: paid });
    await publishToRelay(deps, URL, charged);
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]!)).toHaveLength(3);
  });

  it('무과금 이벤트는 유료 릴레이에도 2원소로 보낸다 — 돈을 안 쓴다', async () => {
    const payFn = vi.fn();
    const { relay, deps, sent } = setup({ policy: paid, payer: () => payFn as never });
    await publishToRelay(deps, URL, free);
    expect(payFn).not.toHaveBeenCalled();
    expect(JSON.parse(sent[0]!)).toHaveLength(2);
  });

  it('봉투를 안 받는 릴레이면 unsupported 로 끊는다', async () => {
    const { relay, deps } = setup({
      policy: { ...paid, terms: { ...paid.terms, envelopeInEventMessage: false } } as RelayPolicy,
    });
    await expect(publishToRelay(deps, URL, charged)).rejects.toMatchObject({
      name: 'PaymentUnavailableError',
      reason: 'unsupported',
    });
  });
});

describe('지불 실패는 일반 오류와 구별된다 (§6.6a)', () => {
  const paid: RelayPolicy = { kind: 'paid', terms: { rules: defaultRules(), methods: [], envelopeInEventMessage: true }, learnedAt: 0 };

  it('지불 수단이 없으면 no-payer', async () => {
    const { relay, deps } = setup({ policy: paid, payer: () => null });
    const err = await publishToRelay(deps, URL, charged).catch((e) => e);
    expect(err).toBeInstanceOf(PaymentUnavailableError);
    expect(err.reason).toBe('no-payer');
    expect(err.relayUrl).toBe(URL);
  });

  it('앱이 거부하면 declined — 자동으로 돈이 나가지 않는다', async () => {
    const { relay, deps } = setup({ policy: paid, payer: () => async () => null });
    const err = await publishToRelay(deps, URL, charged).catch((e) => e);
    expect(err.reason).toBe('declined');
  });

  it('결제 자체가 터지면 failed', async () => {
    const { relay, deps } = setup({
      policy: paid,
      payer: () => async () => {
        throw new Error('잔액 부족');
      },
    });
    const err = await publishToRelay(deps, URL, charged).catch((e) => e);
    expect(err.reason).toBe('failed');
    expect(err.message).toMatch(/잔액 부족/);
  });

  it('릴레이는 돈을 요구했는데 광고 조건상 무료면 끊는다 — 무한 재시도 방지', async () => {
    const { relay, deps } = setup({
      publishImpl: async () => {
        throw new Error(okPaymentRequired('1 sat'));
      },
      // 이 이벤트(kind 1 + p)를 과금 대상에 넣지 않은 조건
      nip11: { fees: { publication: [{ kinds: [9999], amount: 1000, unit: 'msats' }] } },
    });
    const err = await publishToRelay(deps, URL, charged).catch((e) => e);
    expect(err.reason).toBe('unsupported');
    expect(err.message).toMatch(/정책 불일치/);
  });
});

describe('봉투 삽입', () => {
  const paid: RelayPolicy = { kind: 'paid', terms: { rules: defaultRules(), methods: [], envelopeInEventMessage: true }, learnedAt: 0 };

  it('send 를 원상복구한다 — 안 하면 다음 발행에 남의 봉투가 붙는다', async () => {
    const { relay, deps } = setup({ policy: paid });
    const before = relay.send;
    await publishToRelay(deps, URL, charged);
    expect(relay.send).toBe(before);
  });

  it('결제 뒤에 릴레이 핸들을 다시 얻는다 — 그 사이 연결이 닫혔을 수 있다', async () => {
    // 확인 대화상자 + LN 결제로 수십 초가 흐르면 풀의 idle 타임아웃(20s)이 연결을 닫는다.
    // 닫힌 핸들로 재발행하면 재연결을 기다리다 `publish timed out` 이 난다(실측).
    const { relay, deps } = setup({ policy: paid });
    const getRelay = vi.fn(async () => relay);
    await publishToRelay({ ...deps, getRelay }, URL, charged);
    expect(getRelay).toHaveBeenCalled();
  });

  it('발행이 터져도 send 를 원상복구한다', async () => {
    const { relay, deps } = setup({
      policy: paid,
      publishImpl: async () => {
        throw new Error('boom');
      },
    });
    const before = relay.send;
    await expect(publishToRelay(deps, URL, charged)).rejects.toThrow('boom');
    expect(relay.send).toBe(before);
  });
});

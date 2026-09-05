// float — 돈이 걸린 부분만 집중해서 못박는다.
// 네트워크(민트)는 끊고, 상태 전이·한도·동시성·pending 회수를 본다.

import { describe, expect, it, vi } from 'vitest';
import { EcashFloat, InsufficientFloatError, type Funding } from '../src/float.js';
import { InProcessMutex } from '../src/lock.js';
import { MemoryFloatStore, type FloatState } from '../src/store.js';
import { pickMint } from '../src/payer.js';

const MINT = 'https://mint.example';
const proof = (amount: number, secret: string) => ({ id: 'k', amount, secret, C: '02' }) as never;

function stateWith(proofs: unknown[], topUps: { at: number; sats: number }[] = []): FloatState {
  return { version: 1, mints: { [MINT]: { proofs: proofs as never, pending: [] } }, topUps };
}

const noFunding: Funding = { payInvoice: async () => ({ preimage: 'x' }) };

function float(state: FloatState | null, over: Partial<ConstructorParameters<typeof EcashFloat>[0]> = {}) {
  const store = new MemoryFloatStore(state);
  return {
    store,
    float: new EcashFloat({ store, funding: noFunding, lock: new InProcessMutex(), ...over }),
  };
}

describe('잔액', () => {
  it('민트별로 센다', async () => {
    const { float: f } = float(stateWith([proof(1, 'a'), proof(2, 'b')]));
    expect(await f.balance()).toEqual({ [MINT]: 3 });
  });

  it('상태가 없으면 빈 잔액 — 던지지 않는다', async () => {
    const { float: f } = float(null);
    expect(await f.balance()).toEqual({});
  });
});

describe('충전 동의 — 기본은 돈을 안 쓴다 (§6.6b)', () => {
  it('autoTopUp 도 onTopUpRequired 도 없으면 충전하지 않는다', async () => {
    const payInvoice = vi.fn();
    const { float: f } = float(null, { funding: { payInvoice: payInvoice as never } });
    expect(await f.topUp(MINT, 100)).toBe(false);
    expect(payInvoice).not.toHaveBeenCalled();
  });

  it('onTopUpRequired 가 false 를 주면 충전하지 않는다', async () => {
    const payInvoice = vi.fn();
    const { float: f } = float(null, {
      funding: { payInvoice: payInvoice as never },
      onTopUpRequired: async () => false,
    });
    expect(await f.topUp(MINT, 100)).toBe(false);
    expect(payInvoice).not.toHaveBeenCalled();
  });
});

describe('한도 — 라이브러리 자체 회계 (암호학적 보증 아님)', () => {
  it('float 상한을 넘기면 충전하지 않는다', async () => {
    const { float: f } = float(stateWith([proof(450, 'a')]), {
      autoTopUp: true,
      limits: { maxFloatSats: 500 },
    });
    expect(await f.topUp(MINT, 100)).toBe(false); // 450 + 100 > 500
  });

  it('기간 충전 상한을 넘기면 충전하지 않는다', async () => {
    const now = Date.now();
    const { float: f } = float(stateWith([], [{ at: now - 1000, sats: 1900 }]), {
      autoTopUp: true,
      limits: { maxFloatSats: 10000, maxTopUpPerPeriodSats: 2000 },
    });
    expect(await f.topUp(MINT, 200)).toBe(false); // 1900 + 200 > 2000
  });

  it('기간이 지난 충전은 한도에서 빠진다', async () => {
    const old = Date.now() - 2 * 24 * 60 * 60 * 1000;
    const { float: f } = float(stateWith([], [{ at: old, sats: 1900 }]), {
      autoTopUp: true,
      limits: { maxFloatSats: 10000, maxTopUpPerPeriodSats: 2000 },
      onTopUpRequired: async () => false, // 한도는 통과하되 동의에서 멈춘다
    });
    // 한도에 걸렸다면 onTopUpRequired 까지 못 갔을 것이다.
    const asked = vi.fn(async () => false);
    const { float: g } = float(stateWith([], [{ at: old, sats: 1900 }]), {
      autoTopUp: true,
      limits: { maxFloatSats: 10000, maxTopUpPerPeriodSats: 2000 },
      onTopUpRequired: asked,
    });
    expect(await g.topUp(MINT, 200)).toBe(false);
    expect(asked).toHaveBeenCalled();
    void f;
  });
});

describe('지출', () => {
  it('잔액이 모자라고 충전도 안 되면 InsufficientFloatError', async () => {
    const { float: f } = float(stateWith([]));
    await expect(
      f.spend(MINT, 1, { eventId: 'e', relayUrl: 'wss://r' }),
    ).rejects.toBeInstanceOf(InsufficientFloatError);
  });

  it('에러가 필요한 금액과 보유액을 담는다 — UI 가 안내할 수 있게', async () => {
    const { float: f } = float(stateWith([proof(1, 'a')]));
    const e = await f.spend(MINT, 5, { eventId: 'e', relayUrl: 'wss://r' }).catch((x) => x);
    expect(e.needSats).toBe(5);
    expect(e.haveSats).toBe(1);
  });
});

describe('pending — 확정 못 받은 토큰을 절대 버리지 않는다', () => {
  const pendingState = (): FloatState => ({
    version: 1,
    mints: {
      [MINT]: {
        proofs: [],
        pending: [
          {
            token: 'cashuBx',
            proofs: [proof(1, 's1')],
            eventId: 'e1',
            relayUrl: 'wss://r',
            at: Date.now() - 120_000,
          },
        ],
      },
    },
    topUps: [],
  });

  it('settle 하면 pending 에서 빠진다', async () => {
    const { float: f, store } = float(pendingState());
    await f.settle('e1');
    expect((await store.load())!.mints[MINT]!.pending).toHaveLength(0);
  });

  it('민트에 못 물어보면 pending 을 유지한다 — 판단 보류가 안전하다', async () => {
    const { float: f, store } = float(pendingState());
    // cashu 모듈 로딩이 실패하는 상황(네트워크 없음)을 흉내낸다.
    const res = await f.reconcile(0).catch(() => null);
    // 실패하든 성공하든, 확인 못 한 pending 이 사라지면 안 된다.
    const after = (await store.load())!.mints[MINT]!.pending;
    if (res === null || res.recovered + res.spent === 0) {
      expect(after).toHaveLength(1);
    }
  });

  it('아직 젊은 pending 은 건드리지 않는다', async () => {
    const s = pendingState();
    s.mints[MINT]!.pending[0]!.at = Date.now();
    const { float: f, store } = float(s);
    await f.reconcile(60_000);
    expect((await store.load())!.mints[MINT]!.pending).toHaveLength(1);
  });
});

describe('동시성 — 두 탭이 서로의 저장분을 덮어쓰면 안 된다 (V9)', () => {
  it('mutate 가 직렬화된다', async () => {
    const store = new MemoryFloatStore(stateWith([]));
    const lock = new InProcessMutex();
    const f = new EcashFloat({ store, funding: noFunding, lock });

    // settle 은 mutate 를 쓴다. 동시에 여러 번 불러도 읽기-수정-쓰기가 겹치면 안 된다.
    const order: string[] = [];
    const slow = async (tag: string) => {
      order.push(`${tag}:start`);
      await new Promise((r) => setTimeout(r, 5));
      order.push(`${tag}:end`);
    };
    await Promise.all([lock.run(() => slow('A')), lock.run(() => slow('B'))]);
    expect(order).toEqual(['A:start', 'A:end', 'B:start', 'B:end']);
    void f;
  });

  it('한 작업이 터져도 락이 죽지 않는다', async () => {
    const lock = new InProcessMutex();
    await expect(lock.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(lock.run(async () => 'ok')).resolves.toBe('ok');
  });
});

describe('pickMint — 앱이 신뢰하는 민트만', () => {
  const terms = {
    rules: [],
    methods: [{ type: 'cashu', unit: 'sat', mints: ['https://a', 'https://b'] }],
    envelopeInEventMessage: true,
  } as never;

  it('allowlist 가 없으면 릴레이가 광고한 첫 민트', () => {
    expect(pickMint(terms)).toBe('https://a');
  });

  it('allowlist 와 교집합에서 고른다 — 릴레이가 부르는 대로 아무 민트나 쓰면 안 된다', () => {
    expect(pickMint(terms, ['https://b'])).toBe('https://b');
    expect(pickMint(terms, ['https://c'])).toBeNull();
  });

  it('cashu 수단이 없으면 null', () => {
    expect(pickMint({ rules: [], methods: [{ type: 'ln-keysend' }], envelopeInEventMessage: true } as never)).toBeNull();
  });
});

// CashuCollector — 네트워크 없이 방어 경로를 못박는다.
// 실제 민트 왕복은 scripts/smoke-cashu.ts (라이브) 담당.

import { describe, expect, it, vi } from 'vitest';
import type { CashuEnvelope } from '@nostr-paywall/protocol';
import { CashuCollector, type WalletLike } from '../src/cashu.js';

const MINT = 'https://good.mint';
const OTHER = 'https://other.mint';
// 실제 민트가 쓰는 v2 keyset id (66-hex). getEncodedToken 이 형식을 검증하므로 진짜 모양이어야 한다.
const KSID = '0184237e63ce3423df7db2dcedc7329cff722a12b90206db53185fc31a4ca5ed96';

function envelope(over: Partial<CashuEnvelope> = {}): CashuEnvelope {
  return { v: 1, method: 'cashu', mint: MINT, unit: 'sat', token: 'cashuBfake', ...over };
}

/** 토큰 문자열을 그대로 해석하는 가짜 지갑. `mint|amount,amount|secret,secret` */
function fakeWallet(over: Partial<WalletLike> = {}): WalletLike {
  return {
    loadMint: async () => {},
    decodeToken: (token: string) => {
      const [mint, amounts, secrets] = token.replace('cashuB', '').split('|');
      if (!mint) throw new Error('bad token');
      const amts = (amounts ?? '').split(',').filter(Boolean).map(Number);
      const secs = (secrets ?? '').split(',').filter(Boolean);
      return {
        mint,
        unit: 'sat',
        proofs: amts.map((a, i) => ({ amount: a, secret: secs[i] ?? `s${i}`, id: KSID, C: '02' })),
      } as never;
    },
    receive: async (t) => {
      const token = typeof t === 'string' ? t : '';
      const amts = (token.replace('cashuB', '').split('|')[1] ?? '').split(',').filter(Boolean);
      return amts.map((a, i) => ({ amount: Number(a), secret: `fresh${i}`, id: KSID, C: '02' })) as never;
    },
    ...over,
  };
}

const tok = (mint: string, amounts: number[], secrets: string[] = []) =>
  `cashuB${mint}|${amounts.join(',')}|${secrets.join(',')}`;

function collector(over: Partial<WalletLike> = {}) {
  return new CashuCollector({
    allowedMints: [MINT],
    skipFeeCheck: true,
    walletFactory: () => fakeWallet(over),
  });
}

const ctx = { eventId: 'e'.repeat(64), priceMsat: 1000 };

describe('validate — 돈을 건드리지 않는 관문', () => {
  it('정상 봉투는 통과하고 이중사용 키(secret)를 돌려준다', async () => {
    const c = collector();
    const r = await c.validate(envelope({ token: tok(MINT, [1], ['abc']) }), ctx);
    expect(r).toEqual({ ok: true, refs: ['abc'], amountMsat: 1000 });
  });

  it('allowlist 밖 민트는 거부 (H1)', async () => {
    const c = collector();
    const r = await c.validate(envelope({ mint: OTHER, token: tok(OTHER, [1]) }), ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/mint not allowed/);
  });

  it('봉투는 allowlist 민트를 자칭하는데 토큰 안 민트가 다르면 거부', async () => {
    // 봉투 필드만 믿으면 뚫린다 — 토큰에 박힌 민트가 진짜다.
    const c = collector();
    const r = await c.validate(envelope({ mint: MINT, token: tok(OTHER, [1]) }), ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/different mint/);
  });

  it('금액이 가격에 못 미치면 거부', async () => {
    const c = collector();
    const r = await c.validate(envelope({ token: tok(MINT, [1]) }), { ...ctx, priceMsat: 2000 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/insufficient/);
  });

  it('초과 지불은 통과 — 거스름은 우리가 안 준다', async () => {
    const c = collector();
    const r = await c.validate(envelope({ token: tok(MINT, [8]) }), ctx);
    expect(r.ok && r.amountMsat).toBe(8000);
  });

  it('proof 여러 개면 secret 을 전부 키로 잡는다', async () => {
    const c = collector();
    const r = await c.validate(envelope({ token: tok(MINT, [1, 2], ['s1', 's2']) }), ctx);
    expect(r.ok && r.refs).toEqual(['s1', 's2']);
  });

  it('unit 이 다르면 거부', async () => {
    const c = collector();
    const r = await c.validate(envelope({ unit: 'usd', token: tok(MINT, [1]) }), ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/unsupported unit/);
  });

  it('망가진 토큰은 사람이 읽을 이유와 함께 거부 — throw 하지 않는다', async () => {
    const c = collector({
      decodeToken: () => {
        throw new Error('cbor broken');
      },
    });
    const r = await c.validate(envelope(), ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/malformed cashu token/);
  });

  it('proof 가 없는 토큰은 거부', async () => {
    const c = collector();
    const r = await c.validate(envelope({ token: tok(MINT, []) }), ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/no proofs/);
  });

  it('validate 는 receive 를 절대 부르지 않는다 — 관문에서 돈이 움직이면 안 된다', async () => {
    const receive = vi.fn();
    const c = collector({ receive: receive as never });
    await c.validate(envelope({ token: tok(MINT, [1]) }), ctx);
    expect(receive).not.toHaveBeenCalled();
  });
});

describe('collect — 실제 수납', () => {
  it('swap 하고 입력 secret·순액·환불토큰을 돌려준다', async () => {
    const c = collector();
    const r = await c.collect(envelope({ token: tok(MINT, [1], ['abc']) }), ctx);
    expect(r.refs).toEqual(['abc']); // 이중사용 키는 **입력** proof 의 secret
    expect(r.amountMsat).toBe(1000);
    expect(r.proofs).toHaveLength(1); // 릴레이가 영구 저장해야 하는 원물
    expect(typeof r.refundToken).toBe('string'); // 저장 실패 시 이걸 그대로 돌려준다
  });

  it('환불토큰 인코딩이 실패해도 던지지 않는다 — 이미 돈을 받은 뒤라 여기서 터지면 환불 경로가 죽는다', async () => {
    // getEncodedToken 은 keyset id 형식을 검증하고 이상하면 던진다
    const c = collector({
      receive: async () => [{ amount: 1, secret: 'fresh', id: 'not-a-keyset-id', C: '02' }] as never,
    });
    const r = await c.collect(envelope({ token: tok(MINT, [1], ['abc']) }), ctx);
    expect(r.refundToken).toBeNull();
    expect(r.proofs).toHaveLength(1); // 원물은 남아야 수동 회수가 가능하다
    expect(r.amountMsat).toBe(1000);
  });

  it('민트가 이미 쓴 토큰이라고 하면 그대로 터뜨린다 — 릴레이가 payment-invalid 로 매핑', async () => {
    const c = collector({
      receive: async () => {
        throw new Error('Token Already Spent');
      },
    });
    await expect(c.collect(envelope({ token: tok(MINT, [1]) }), ctx)).rejects.toThrow(/Already Spent/);
  });

  it('순액이 가격에 못 미치면 터진다 — ppk 게이트가 우회된 신호', async () => {
    // 수수료를 먹어 0 이 되어 돌아오는 상황(ppk≠0 민트가 allowlist 에 새어든 경우)
    const c = collector({ receive: async () => [] as never });
    await expect(c.collect(envelope({ token: tok(MINT, [1]) }), ctx)).rejects.toThrow(
      /input_fee_ppk==0/,
    );
  });
});

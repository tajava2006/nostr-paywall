// 클라이언트 ecash float.
//
// **레일 무관성의 유일한 경로**다(PLAN D10). NWC 코어에 keysend 가 없어서,
// 릴레이가 무엇을 받든 앱은 `payInvoice`/`makeInvoice` 두 개만 제공하면 된다:
// 그 인보이스로 민트에서 ecash 를 사고(NUT-04), 이벤트당 1 sat 씩 쓴다.

import type { Proof } from '@cashu/cashu-ts';
import type { PaymentEnvelope } from '@nostr-paywall/protocol';
import { createLock, type FloatLock } from './lock.js';
import { findAffordableAmount, requestInvoice, resolveLightningAddress } from './lnurl.js';
import {
  emptyState,
  type FloatState,
  type FloatStore,
  type MintBucket,
  type PendingSpend,
} from './store.js';

// cashu-ts 는 ESM 전용이라 CJS 소비자를 위해 런타임 값만 지연 로딩한다
// (collectors 와 같은 이유). 타입은 `import type` 이라 사라진다.
type CashuModule = typeof import('@cashu/cashu-ts');
let cashuPromise: Promise<CashuModule> | undefined;
function cashu(): Promise<CashuModule> {
  cashuPromise ??= import('@cashu/cashu-ts');
  return cashuPromise;
}

export interface Funding {
  /** 충전 — 민트가 준 bolt11 을 결제한다. 보통 NWC `pay_invoice`. */
  payInvoice(bolt11: string): Promise<{ preimage: string }>;
  /** 환불 — 남은 ecash 를 여기로 녹여 보낸다. 보통 NWC `make_invoice`. */
  makeInvoice?(amountSats: number): Promise<string>;
}

export interface FloatLimits {
  /** float 이 들고 있을 상한. 작게 유지하는 게 저장소 축출·XSS 에 대한 진짜 방어다. */
  maxFloatSats: number;
  /** 기간(기본 24h)당 충전 상한. 라이브러리 자체 회계 — 암호학적 보증이 아니다. */
  maxTopUpPerPeriodSats: number;
  periodMs?: number;
}

export interface EcashFloatOptions {
  store: FloatStore;
  funding: Funding;
  /** 릴레이가 광고한 민트 중 우리가 쓸 것. 보통 릴레이 terms 에서 고른다. */
  limits?: Partial<FloatLimits>;
  /**
   * **기본 false.** 라이브러리 init 만으로 유저 돈이 나가면 안 된다(PLAN §6.6b).
   * 켜지 않으면 잔액이 모자랄 때 `onTopUpRequired` 를 부르고, 그것도 없으면 포기한다.
   */
  autoTopUp?: boolean;
  /** 충전 동의를 앱에 묻는다. `false` 를 돌려주면 충전하지 않는다. */
  onTopUpRequired?: (info: { mint: string; sats: number }) => Promise<boolean>;
  /** 한 번에 충전할 금액. 이벤트당 1 sat 이므로 500 이면 500건. */
  topUpSats?: number;
  lock?: FloatLock;
}

const DEFAULT_LIMITS: FloatLimits = {
  maxFloatSats: 500,
  maxTopUpPerPeriodSats: 2000,
  periodMs: 24 * 60 * 60 * 1000,
};

function bucket(state: FloatState, mint: string): MintBucket {
  state.mints[mint] ??= { proofs: [], pending: [] };
  return state.mints[mint]!;
}

const sats = (proofs: readonly { amount: unknown }[]) =>
  proofs.reduce((s, p) => s + Number(p.amount), 0);

export class InsufficientFloatError extends Error {
  readonly name = 'InsufficientFloatError';
  constructor(readonly mint: string, readonly needSats: number, readonly haveSats: number) {
    super(`${mint} 잔액 부족: ${haveSats} sat 보유, ${needSats} sat 필요`);
  }
}

export class EcashFloat {
  private readonly lock: FloatLock;
  private readonly limits: FloatLimits;

  constructor(private readonly opts: EcashFloatOptions) {
    this.lock = opts.lock ?? createLock();
    this.limits = { ...DEFAULT_LIMITS, ...opts.limits };
  }

  private async mutate<T>(fn: (state: FloatState) => Promise<T>): Promise<T> {
    // 읽기·수정·쓰기 전체가 하나의 임계구역이어야 한다. 아니면 탭 두 개가
    // 서로의 저장분을 덮어써서 ecash 를 잃는다.
    return this.lock.run(async () => {
      const state = (await this.opts.store.load()) ?? emptyState();
      const out = await fn(state);
      await this.opts.store.save(state);
      return out;
    });
  }

  /** 민트별 잔액(sat). */
  async balance(): Promise<Record<string, number>> {
    const state = (await this.opts.store.load()) ?? emptyState();
    return Object.fromEntries(
      Object.entries(state.mints).map(([mint, b]) => [mint, sats(b.proofs)]),
    );
  }

  // ─── 충전 ──────────────────────────────────────────────────────

  private periodTopUpSats(state: FloatState, now: number): number {
    const since = now - (this.limits.periodMs ?? DEFAULT_LIMITS.periodMs!);
    return state.topUps.filter((t) => t.at >= since).reduce((s, t) => s + t.sats, 0);
  }

  /**
   * 민트에서 ecash 를 산다. NUT-04 견적(bolt11) → `funding.payInvoice` → mint.
   *
   * 한도를 넘거나 동의를 못 받으면 `false`.
   */
  async topUp(mint: string, requestSats?: number): Promise<boolean> {
    const amount = requestSats ?? this.opts.topUpSats ?? this.limits.maxFloatSats;
    const now = Date.now();

    const allowed = await this.mutate(async (state) => {
      const have = sats(bucket(state, mint).proofs);
      if (have + amount > this.limits.maxFloatSats) return false;
      if (this.periodTopUpSats(state, now) + amount > this.limits.maxTopUpPerPeriodSats) return false;
      return true;
    });
    if (!allowed) return false;

    if (this.opts.onTopUpRequired) {
      if (!(await this.opts.onTopUpRequired({ mint, sats: amount }))) return false;
    } else if (!this.opts.autoTopUp) {
      // 명시적 동의 경로가 없고 자동도 아니면 돈을 쓰지 않는다.
      return false;
    }

    const { Wallet } = await cashu();
    const wallet = new Wallet(mint);
    await wallet.loadMint();
    const quote = await wallet.createMintQuoteBolt11(amount);
    await this.opts.funding.payInvoice(quote.request);

    // 결제가 민트에 반영될 때까지 잠깐 기다린다.
    let paid = quote;
    for (let i = 0; i < 30 && paid.state !== 'PAID'; i++) {
      await new Promise((r) => setTimeout(r, 500));
      paid = await wallet.checkMintQuoteBolt11(quote.quote);
    }
    if (paid.state !== 'PAID') {
      throw new Error(`민트가 결제를 확인하지 못했다 (quote=${quote.quote}, state=${paid.state})`);
    }

    const proofs = await wallet.mintProofsBolt11(amount, quote.quote);
    await this.mutate(async (state) => {
      bucket(state, mint).proofs.push(...proofs);
      state.topUps.push({ at: now, sats: amount });
    });
    return true;
  }

  // ─── 지출 ──────────────────────────────────────────────────────

  /**
   * `amountSats` 만큼의 봉투를 만든다.
   *
   * 잔액이 모자라면 한 번 충전을 시도하고, 그래도 모자라면 `InsufficientFloatError`.
   * 만들어진 토큰은 **pending 으로 기록**된다 — 릴레이 응답을 못 받아도 버리지 않는다.
   */
  async spend(
    mint: string,
    amountSats: number,
    ctx: { eventId: string; relayUrl: string },
  ): Promise<PaymentEnvelope> {
    let have = (await this.balance())[mint] ?? 0;
    if (have < amountSats) {
      await this.topUp(mint);
      have = (await this.balance())[mint] ?? 0;
      if (have < amountSats) throw new InsufficientFloatError(mint, amountSats, have);
    }

    const { Wallet, getEncodedToken } = await cashu();
    const wallet = new Wallet(mint);
    await wallet.loadMint();

    return this.mutate(async (state) => {
      const b = bucket(state, mint);
      // 정확히 amountSats 를 만들기 위해 민트에서 쪼갠다. `send` 가 거스름을 돌려준다.
      const { keep, send } = await wallet.send(amountSats, b.proofs);
      const token = getEncodedToken({ mint, unit: 'sat', proofs: send });

      b.proofs = keep as Proof[];
      b.pending.push({
        token,
        proofs: send as Proof[],
        eventId: ctx.eventId,
        relayUrl: ctx.relayUrl,
        at: Date.now(),
      });
      return { v: 1, method: 'cashu', mint, unit: 'sat', token } satisfies PaymentEnvelope;
    });
  }

  /** 릴레이가 확실히 받았다. pending 에서 제거한다. */
  async settle(eventId: string): Promise<void> {
    await this.mutate(async (state) => {
      for (const b of Object.values(state.mints)) {
        b.pending = b.pending.filter((p) => p.eventId !== eventId);
      }
    });
  }

  /**
   * pending 정리 (PLAN §6 pending-proof GC).
   *
   * 릴레이 응답을 못 받은 토큰들을 민트에 물어본다(NUT-07 checkstate).
   * **미사용이면 되살리고**, 쓰였으면 버린다. 이게 없으면 "썼는지 모름" 상태의
   * ecash 가 영원히 묶인다.
   */
  async reconcile(olderThanMs = 60_000): Promise<{ recovered: number; spent: number }> {
    const cutoff = Date.now() - olderThanMs;
    const state = (await this.opts.store.load()) ?? emptyState();
    let recovered = 0;
    let spent = 0;

    for (const [mint, b] of Object.entries(state.mints)) {
      const stale = b.pending.filter((p) => p.at < cutoff);
      if (stale.length === 0) continue;

      const { Wallet } = await cashu();
      const wallet = new Wallet(mint);
      await wallet.loadMint();

      for (const p of stale) {
        let unspent: boolean;
        try {
          const states = await wallet.checkProofsStates(p.proofs);
          unspent = states.every((s) => s.state === 'UNSPENT');
        } catch {
          continue; // 민트에 못 물어봤으면 판단 보류 — 절대 버리지 않는다
        }
        await this.mutate(async (s) => {
          const bb = bucket(s, mint);
          bb.pending = bb.pending.filter((x) => x.token !== p.token);
          if (unspent) bb.proofs.push(...p.proofs);
        });
        if (unspent) recovered += sats(p.proofs);
        else spent += sats(p.proofs);
      }
    }
    return { recovered, spent };
  }

  // ─── 환불 ──────────────────────────────────────────────────────

  /**
   * 남은 ecash 를 **라이트닝 주소**로 되돌린다 (LUD-16 → NUT-05 melt).
   *
   * `makeInvoice` 보다 이쪽이 낫다: melt 는 금액이 박힌 bolt11 을 요구하는데
   * 얼마짜리를 만들지는 melt 견적을 받아봐야 안다(수수료 예약분 때문). 유저에게
   * 물어도 유저가 모르는 그 문제를, 라이트닝 주소면 **우리가 금액을 정해 인보이스를
   * 뽑을 수 있어서** 반복으로 수렴시킬 수 있다.
   *
   * pending 은 건드리지 않는다 — 먼저 `reconcile()` 로 정리할 것.
   */
  async refundToLightningAddress(
    address: string,
  ): Promise<{ mint: string; sentSats: number; feeSats: number }[]> {
    const params = await resolveLightningAddress(address);
    const state = (await this.opts.store.load()) ?? emptyState();
    const out: { mint: string; sentSats: number; feeSats: number }[] = [];

    for (const [mint, b] of Object.entries(state.mints)) {
      const total = sats(b.proofs);
      if (total < 2) continue; // 수수료도 안 되는 잔액

      const { Wallet } = await cashu();
      const wallet = new Wallet(mint);
      await wallet.loadMint();

      const found = await findAffordableAmount(total, async (send) => {
        const invoice = await requestInvoice(params, send);
        const quote = await wallet.createMeltQuoteBolt11(invoice);
        const needed = Number(quote.amount) + Number(quote.fee_reserve ?? 0);
        return { neededSats: needed, quote };
      });
      if (!found) continue;

      const quote = found.quote as Awaited<ReturnType<typeof wallet.createMeltQuoteBolt11>>;
      const { keep, send } = await wallet.send(found.neededSats, b.proofs);
      const res = await wallet.meltProofsBolt11(quote, send);

      // NUT-08: 안 쓴 수수료 예약분이 change 로 돌아온다. 버리면 그대로 손해다.
      const change = (res as { change?: Proof[] }).change ?? [];
      await this.mutate(async (s) => {
        const bb = bucket(s, mint);
        bb.proofs = [...(keep as Proof[]), ...change];
      });

      out.push({
        mint,
        sentSats: found.sendSats,
        feeSats: found.neededSats - found.sendSats - sats(change),
      });
    }
    return out;
  }

  /**
   * 남은 ecash 를 유저 지갑으로 되돌린다 (NUT-05 melt → `funding.makeInvoice`).
   *
   * 금액을 우리가 못 정하므로 `refundToLightningAddress` 쪽이 낫다.
   * pending 은 건드리지 않는다 — 먼저 `reconcile()` 로 정리할 것.
   */
  async refundAll(): Promise<{ mint: string; sats: number }[]> {
    if (!this.opts.funding.makeInvoice) {
      throw new Error('환불하려면 funding.makeInvoice 가 필요하다');
    }
    const state = (await this.opts.store.load()) ?? emptyState();
    const out: { mint: string; sats: number }[] = [];

    for (const [mint, b] of Object.entries(state.mints)) {
      const total = sats(b.proofs);
      if (total <= 1) continue; // 수수료도 안 되는 잔액은 건드리지 않는다

      const { Wallet } = await cashu();
      const wallet = new Wallet(mint);
      await wallet.loadMint();

      // 라이트닝 수수료만큼 여유를 둔다. 남는 건 다음 환불 때.
      const invoice = await this.opts.funding.makeInvoice!(total - 1);
      const quote = await wallet.createMeltQuoteBolt11(invoice);
      const needed = Number(quote.amount) + Number(quote.fee_reserve ?? 0);
      if (needed > total) continue;

      const { keep, send } = await wallet.send(needed, b.proofs);
      await wallet.meltProofsBolt11(quote, send);

      await this.mutate(async (s) => {
        bucket(s, mint).proofs = keep as Proof[];
      });
      out.push({ mint, sats: Number(quote.amount) });
    }
    return out;
  }
}

// Cashu collector — v1 의 주 레일.
//
// 토큰은 **unlocked** 다(PLAN D5). 클라가 우리보다 먼저 회수해가면 swap 이 실패하고
// 우리는 그냥 이벤트를 저장 안 하면 그만이라, 레이스를 져도 릴레이 손해가 0이다.

import type { Proof, Token } from '@cashu/cashu-ts';
import { isMintAllowed, type PaymentEnvelope } from '@nostr-paywall/protocol';
import { assertZeroFeeMints } from './mint-policy.js';
import type { CollectContext, CollectResult, Collector, ValidateResult } from './types.js';

// ─── cashu-ts 지연 로딩 ─────────────────────────────────────────
//
// cashu-ts 는 ESM 전용(`type: module`)인데 이 패키지를 쓰는 릴레이 대부분은 CJS 다
// (NestJS 기본). 정적 import 를 두면 CJS 빌드에서 `require()` 로 내려가 죽는다:
//   SyntaxError: Unexpected token 'export'
// 동적 import 는 CJS 에서도 ESM 을 읽을 수 있으므로 런타임 값만 지연 로딩한다.
// 타입은 `import type` 이라 컴파일 때 사라진다.
type CashuModule = typeof import('@cashu/cashu-ts');
let cashuPromise: Promise<CashuModule> | undefined;
function cashu(): Promise<CashuModule> {
  cashuPromise ??= import('@cashu/cashu-ts');
  return cashuPromise;
}

/** 테스트에서 네트워크를 끊기 위한 최소 계약. `Wallet` 이 구조적으로 만족한다. */
export interface WalletLike {
  loadMint(): Promise<void>;
  decodeToken(token: string): Token;
  receive(token: string | Token): Promise<Proof[]>;
}

export interface CashuCollectorOptions {
  /** 상환 가능한 민트만(H1). 전부 `input_fee_ppk==0` 이어야 한다(H1b). */
  allowedMints: readonly string[];
  unit?: string;
  /** 주입점 — 테스트/대체 구현용. */
  walletFactory?: (mint: string) => WalletLike;
  /** 부팅 게이트를 건너뛴다. **테스트 전용.** */
  skipFeeCheck?: boolean;
}

const SAT_TO_MSAT = 1000;

function sumSats(proofs: readonly { amount: unknown }[]): number {
  // cashu-ts v4 의 Proof.amount 는 Amount(bigint 래퍼)라 그냥 더하면 문자열이 된다.
  return proofs.reduce((s, p) => s + Number(p.amount), 0);
}

export class CashuCollector implements Collector {
  readonly method = 'cashu';

  private readonly allowedMints: readonly string[];
  private readonly unit: string;
  private readonly walletFactory: ((mint: string) => WalletLike) | undefined;
  private readonly skipFeeCheck: boolean;
  private readonly wallets = new Map<string, Promise<WalletLike>>();

  constructor(opts: CashuCollectorOptions) {
    this.allowedMints = opts.allowedMints;
    this.unit = opts.unit ?? 'sat';
    this.skipFeeCheck = opts.skipFeeCheck ?? false;
    this.walletFactory = opts.walletFactory;
  }

  /** 부팅 게이트. ppk≠0 민트가 하나라도 있으면 던져서 릴레이를 못 띄우게 한다. */
  async init(): Promise<void> {
    if (!this.skipFeeCheck) await assertZeroFeeMints(this.allowedMints, this.unit);
    // 지갑을 미리 데워둔다 — loadMint 가 300ms~1s 라 이벤트 경로에서 빼야 한다.
    await Promise.all(this.allowedMints.map((m) => this.wallet(m)));
  }

  private wallet(mint: string): Promise<WalletLike> {
    let w = this.wallets.get(mint);
    if (!w) {
      w = (async () => {
        const wallet =
          this.walletFactory?.(mint) ??
          ((new (await cashu()).Wallet(mint) as unknown) as WalletLike);
        await wallet.loadMint();
        return wallet;
      })();
      this.wallets.set(mint, w);
      // 실패한 약속을 캐시에 남기면 영구 고장이 된다.
      w.catch(() => this.wallets.delete(mint));
    }
    return w;
  }

  /**
   * **돈을 건드리지 않는다.** 민트 정책·토큰 모양·금액만 본다.
   *
   * 반환하는 `refs` 는 입력 proof 의 secret — 릴레이가 이걸로 이중사용을 막고
   * 멱등 재시도(같은 refs + 같은 event_id)를 식별한다(§3.6).
   */
  async validate(envelope: PaymentEnvelope, ctx: CollectContext): Promise<ValidateResult> {
    if (envelope.method !== 'cashu') {
      return { ok: false, reason: `unsupported payment method: ${envelope.method}` };
    }
    if (!isMintAllowed(envelope, this.allowedMints)) {
      return { ok: false, reason: `mint not allowed: ${envelope.mint}` };
    }
    if (envelope.unit !== this.unit) {
      return { ok: false, reason: `unsupported unit: ${envelope.unit}` };
    }

    let decoded: Token;
    try {
      decoded = (await this.wallet(envelope.mint)).decodeToken(envelope.token);
    } catch (e) {
      return { ok: false, reason: `malformed cashu token: ${(e as Error).message}` };
    }

    // 봉투의 `mint` 필드만 믿으면 안 된다 — 토큰 안에 박힌 민트가 진짜다.
    // allowlist 민트를 자칭하면서 다른 민트의 토큰을 싣는 걸 막는다.
    if (!this.allowedMints.includes(decoded.mint)) {
      return { ok: false, reason: `token issued by a different mint: ${decoded.mint}` };
    }

    const proofs = decoded.proofs ?? [];
    if (proofs.length === 0) return { ok: false, reason: 'cashu token carries no proofs' };

    const amountMsat = sumSats(proofs) * SAT_TO_MSAT;
    if (amountMsat < ctx.priceMsat) {
      return {
        ok: false,
        reason: `insufficient payment: ${amountMsat / SAT_TO_MSAT} sat < ${ctx.priceMsat / SAT_TO_MSAT} sat`,
      };
    }

    const refs = proofs.map((p) => p.secret);
    if (refs.some((s) => typeof s !== 'string' || s.length === 0)) {
      return { ok: false, reason: 'cashu proof missing secret' };
    }
    return { ok: true, refs, amountMsat };
  }

  /**
   * 실제 수납. **validate 가 ok 를 준 봉투에만** 부른다.
   *
   * swap 이 곧 유효성의 구속력 있는 확인이다 — `checkstate` 조회는 TOCTOU 라
   * 게이트로 못 쓴다(PLAN §3.4).
   */
  async collect(envelope: PaymentEnvelope, ctx: CollectContext): Promise<CollectResult> {
    if (envelope.method !== 'cashu') throw new Error(`method mismatch: ${envelope.method}`);
    const wallet = await this.wallet(envelope.mint);

    const before = wallet.decodeToken(envelope.token);
    const refs = (before.proofs ?? []).map((p) => p.secret);

    const fresh = await wallet.receive(envelope.token);
    const amountMsat = sumSats(fresh) * SAT_TO_MSAT;
    if (amountMsat < ctx.priceMsat) {
      // ppk==0 게이트가 있으면 여기 오면 안 된다. 오면 게이트가 뚫린 것이다.
      throw new Error(
        `수납 순액이 가격에 못 미친다 (${amountMsat} < ${ctx.priceMsat} msat). ` +
          `민트 수수료 게이트(input_fee_ppk==0)가 우회됐는지 확인할 것.`,
      );
    }

    // 인코딩은 던질 수 있다(예: 레거시 keyset id). 여기서 터지면 **이미 돈을 받은 뒤**라
    // 환불 경로가 통째로 무력해지므로 삼킨다 — proofs 원물은 어차피 같이 넘긴다.
    let refundToken: string | null = null;
    try {
      const { getEncodedToken } = await cashu();
      refundToken = getEncodedToken({ mint: envelope.mint, unit: this.unit, proofs: fresh });
    } catch {
      refundToken = null;
    }

    return { refs, amountMsat, proofs: fresh, refundToken };
  }
}

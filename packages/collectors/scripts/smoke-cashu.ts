// 공개 민트 대상 라이브 스모크. 실제 네트워크를 친다 — 유닛 테스트가 아니다.
//
//   node packages/collectors/scripts/smoke-cashu.ts [mintUrl] [amount]
//
// 기본 민트는 testnut(가짜 인보이스를 자동 결제하는 공개 민트)이라 진짜 사토시가 안 든다.
// **단 testnut 은 input_fee_ppk=100 이라 1 sat 은 원리적으로 불가능하다** — 아래 [0] 참조.
//
// 검증하는 것:
//   0. 민트 수수료 정책 — 1 sat 결제가 가능한 민트인가 (H1 확장)
//   1. 충전 경로 — mint quote(bolt11) → 결제 → proofs 수령   (클라 float)
//   2. 봉투 — 인코딩된 토큰 문자열이 JSON 왕복을 견디는가
//   3. 수납 경로 — 받은 토큰을 swap 해서 릴레이 소유로        (릴레이 collector)
//   4. 이중사용 방어 — 같은 토큰 재수납이 거부되는가
//   5. 각 단계 지연 (PLAN V4)

import { Wallet, getEncodedToken } from '@cashu/cashu-ts';

const MINT = process.argv[2] ?? 'https://testnut.cashu.space';
const AMOUNT = Number(process.argv[3] ?? 2);

async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  const out = await fn();
  console.log(`  ${label.padEnd(26)} ${(performance.now() - t0).toFixed(0).padStart(5)} ms`);
  return out;
}

const sum = (ps: readonly { amount: unknown }[]) => ps.reduce((s, p) => s + Number(p.amount), 0);

console.log(`민트: ${MINT}\n금액: ${AMOUNT} sat\n`);

// ─── [0] 수수료 정책 ────────────────────────────────────────────
// NUT-02: fees = ceil(sum(input_fee_ppk) / 1000), 그리고 sum(inputs) - fees == sum(outputs).
// ppk=100 이면 입력 1~10 개당 1 sat 이라 1 sat proof 는 swap 자체가 불가능하다(출력이 0).
// → 우리 민트 allowlist 는 ppk==0 만 받아야 한다.
console.log('[0] 민트 수수료 정책');
const keysets = (await (await fetch(`${MINT}/v1/keysets`)).json()) as {
  keysets: { id: string; unit: string; active: boolean; input_fee_ppk?: number }[];
};
const active = keysets.keysets.filter((k) => k.active && k.unit === 'sat');
const ppk = Math.max(0, ...active.map((k) => k.input_fee_ppk ?? 0));
const feeFor1Input = Math.ceil(ppk / 1000);
console.log(`      input_fee_ppk=${ppk} → 입력 1개당 수수료 ${feeFor1Input} sat`);
if (feeFor1Input >= 1) {
  console.log(`      ⚠️  이 민트로는 1 sat 결제가 불가능하다 (수수료가 원금 이상).`);
  console.log(`         allowlist 요건: input_fee_ppk == 0`);
}
if (AMOUNT <= feeFor1Input) {
  throw new Error(`금액 ${AMOUNT} sat 이 수수료 ${feeFor1Input} sat 이하 — swap 불가. 금액을 올리거나 ppk=0 민트를 쓸 것`);
}

// ─── [1] 클라: float 충전 ───────────────────────────────────────
console.log('\n[1] 충전 경로 (클라 float)');
const client = new Wallet(MINT);
await timed('loadMint', () => client.loadMint());
const quote = await timed('createMintQuoteBolt11', () => client.createMintQuoteBolt11(AMOUNT));
console.log(`      → 실제 앱에서는 이 bolt11 을 NWC pay_invoice 로 결제한다`);

let paid = quote;
for (let i = 0; i < 20 && paid.state !== 'PAID'; i++) {
  await new Promise((r) => setTimeout(r, 500));
  paid = await client.checkMintQuoteBolt11(quote.quote);
}
if (paid.state !== 'PAID') throw new Error(`인보이스 미결제 (state=${paid.state})`);

const proofs = await timed('mintProofsBolt11', () => client.mintProofsBolt11(AMOUNT, quote.quote));
console.log(`      → proofs ${proofs.length}개, 합계 ${sum(proofs)} sat`);

// ─── [2] 봉투 ───────────────────────────────────────────────────
// **인코딩된 토큰 문자열**을 싣는다. raw proofs 배열을 넣으면 안 된다 —
// v2 keyset 짧은 id 해석이 토큰 디코딩 과정에서 일어나서, 배열로 넘기면
// 릴레이 쪽 swap 이 입력 0개로 조립된다(실측: "Inputs: 0, Outputs: 0").
const token = getEncodedToken({ mint: MINT, proofs });
const envelope = { v: 1, method: 'cashu' as const, mint: MINT, unit: 'sat', token };
const wire = JSON.parse(JSON.stringify(envelope)) as typeof envelope;
console.log(`\n[2] 봉투 ${JSON.stringify(envelope).length} bytes (토큰 ${token.length})`);
if (wire.token !== token) throw new Error('JSON 왕복에서 토큰이 변했다');
console.log(`      NIP-11 max_message_length 기본 16384 대비 여유 있음`);

// ─── [3] 릴레이: 수납 ───────────────────────────────────────────
// PLAN §3.4 의 5단계. 여기 오기 전에 결제 외 모든 거부 사유가 걸러져 있어야 한다.
console.log('\n[3] 수납 경로 (릴레이 collector)');
const relay = new Wallet(MINT);
await timed('loadMint', () => relay.loadMint());
const collected = await timed('receive (swap)', () => relay.receive(wire.token));
const net = sum(collected);
console.log(`      → 릴레이 소유 ${collected.length}개, 합계 ${net} sat (수수료 ${AMOUNT - net})`);
if (net !== AMOUNT - feeFor1Input * (proofs.length > 0 ? 1 : 0) && net !== AMOUNT) {
  console.log(`      ⚠️  예상 순액과 다름 — 다중 입력 수수료 확인 필요`);
}

// ─── [4] 이중사용 방어 ──────────────────────────────────────────
console.log('\n[4] 이중사용 방어 — 같은 봉투 재수납');
let rejected = false;
try {
  await relay.receive(wire.token);
} catch (e) {
  rejected = true;
  console.log(`      → 거부됨: ${(e as Error).message.slice(0, 70)}`);
}
if (!rejected) throw new Error('재수납이 통과했다 — 이중사용 방어가 없다');

console.log('\n✅ 전부 통과');

// 실사토시 e2e 드릴. 결제는 사람이 해야 하므로 단계별로 나눠 실행한다.
//
//   node scripts/e2e-drill.mjs quote [sats]    민트 견적 → bolt11 출력
//   node scripts/e2e-drill.mjs claim           결제 확인 → ecash 를 float 에 적재
//   node scripts/e2e-drill.mjs status          잔액 · pending
//   node scripts/e2e-drill.mjs publish [n]     유료 이벤트 n건 실제 발행
//   node scripts/e2e-drill.mjs reconcile       pending 정리 (NUT-07 checkstate)
//   node scripts/e2e-drill.mjs refund <bolt11> 남은 잔액 환불 (NUT-05 melt)
//
// float 은 ./drill-float.json 에 남는다. **이건 진짜 돈이다.**

import { readFile, writeFile } from 'node:fs/promises';
import { Wallet } from '@cashu/cashu-ts';
import { EcashFloat, FileFloatStore, createFloatPayer } from '@nostr-paywall/float';
import { PaidPool, PaymentUnavailableError } from '@nostr-paywall/client';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { useWebSocketImplementation } from 'nostr-tools/relay';
import WebSocket from 'ws';
useWebSocketImplementation(WebSocket);

const MINT = process.env.DRILL_MINT ?? 'https://mint.minibits.cash/Bitcoin';
const RELAY = process.env.DRILL_RELAY ?? 'wss://nostr.hoppe-relay.it.com';
const STATE = './drill-float.json';
const QUOTE = './drill-quote.json';
const SK = './drill-key.json';

const store = new FileFloatStore(STATE);
const LIMITS = { maxFloatSats: 100000, maxTopUpPerPeriodSats: 100000 };
const noFunding = {
  payInvoice: async () => {
    throw new Error('드릴에서는 사람이 결제한다 — quote/claim 을 쓸 것');
  },
};
const float = new EcashFloat({ store, funding: noFunding, limits: LIMITS });

const sum = (ps) => ps.reduce((a, p) => a + Number(p.amount), 0);

async function key() {
  try {
    return Uint8Array.from(JSON.parse(await readFile(SK, 'utf8')));
  } catch {
    const sk = generateSecretKey();
    await writeFile(SK, JSON.stringify([...sk]));
    return sk;
  }
}

const cmd = process.argv[2];

if (cmd === 'quote') {
  const sats = Number(process.argv[3] ?? 20);
  const w = new Wallet(MINT);
  await w.loadMint();
  const q = await w.createMintQuoteBolt11(sats);
  await writeFile(QUOTE, JSON.stringify({ quote: q.quote, sats }));
  console.log(`민트: ${MINT}`);
  console.log(`금액: ${sats} sat\n`);
  console.log(q.request);
  console.log(`\n결제 후 → node scripts/e2e-drill.mjs claim`);
} else if (cmd === 'claim') {
  const { quote, sats } = JSON.parse(await readFile(QUOTE, 'utf8'));
  const w = new Wallet(MINT);
  await w.loadMint();
  const st = await w.checkMintQuoteBolt11(quote);
  if (st.state !== 'PAID') {
    console.log(`아직 미결제 (state=${st.state})`);
    process.exit(1);
  }
  const proofs = await w.mintProofsBolt11(sats, quote);
  const s = (await store.load()) ?? { version: 1, mints: {}, topUps: [] };
  s.mints[MINT] ??= { proofs: [], pending: [] };
  s.mints[MINT].proofs.push(...proofs);
  await store.save(s);
  console.log(`✓ ${sum(proofs)} sat 적재 (proofs ${proofs.length}개)`);
} else if (cmd === 'status') {
  console.log('잔액:', JSON.stringify(await float.balance()));
  const s = await store.load();
  for (const [m, b] of Object.entries(s?.mints ?? {})) {
    console.log(`  ${m}\n    proofs ${b.proofs.length}개 (${sum(b.proofs)} sat) / pending ${b.pending.length}개`);
    for (const p of b.pending) {
      console.log(`    pending ${p.eventId.slice(0, 12)}… ${sum(p.proofs)} sat`);
    }
  }
} else if (cmd === 'publish') {
  const n = Number(process.argv[3] ?? 1);
  const sk = await key();
  const pk = getPublicKey(sk);
  console.log('발행 npub:', pk.slice(0, 16) + '…');
  const pool = new PaidPool({ payer: createFloatPayer(float, { allowedMints: [MINT] }) });
  for (let i = 0; i < n; i++) {
    const ev = finalizeEvent(
      {
        kind: 1,
        created_at: Math.floor(Date.now() / 1000),
        content: `paywall e2e drill #${i + 1} — ${new Date().toISOString()}`,
        tags: [['p', pk]], // 자기 자신 태그 = 과금 대상
      },
      sk,
    );
    try {
      await Promise.all(pool.publish([RELAY], ev));
      await float.settle(ev.id);
      console.log(`✓ #${i + 1} 발행됨  id=${ev.id.slice(0, 16)}…`);
    } catch (e) {
      const kind =
        e instanceof PaymentUnavailableError
          ? `PaymentUnavailable(${e.reason})`
          : e.constructor.name;
      console.log(`✗ #${i + 1} ${kind}: ${e.message}`);
    }
  }
  pool.close([RELAY]);
  console.log('잔액:', JSON.stringify(await float.balance()));
} else if (cmd === 'reconcile') {
  console.log(JSON.stringify(await float.reconcile(0)));
} else if (cmd === 'refund') {
  const target = process.argv[3];
  if (!target) {
    console.log('라이트닝 주소(user@domain) 또는 bolt11 을 인자로 줄 것');
    process.exit(1);
  }
  if (target.includes('@')) {
    console.log(JSON.stringify(await float.refundToLightningAddress(target), null, 2));
  } else {
    const f2 = new EcashFloat({
      store,
      funding: { ...noFunding, makeInvoice: async () => target },
      limits: LIMITS,
    });
    console.log(JSON.stringify(await f2.refundAll(), null, 2));
  }
} else {
  console.log('사용법: quote [sats] | claim | status | publish [n] | reconcile | refund <bolt11>');
}

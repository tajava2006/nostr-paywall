// 운영 릴레이 대상 라이브 확인. 결제는 아직 안 한다 — 학습 경로만 본다.
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { useWebSocketImplementation } from 'nostr-tools/relay';
import WebSocket from 'ws';
import { PaidPool, PaymentUnavailableError } from '@nostr-paywall/client';
useWebSocketImplementation(WebSocket);

const URL = process.argv[2] ?? 'wss://nostr.hoppe-relay.it.com';
const sk = generateSecretKey();
console.log('일회용 npub:', getPublicKey(sk).slice(0, 16) + '…');

const pool = new PaidPool();   // payer 없음 — 지불 수단이 없는 앱을 흉내
const mk = (tags, content) => finalizeEvent({ kind: 1, created_at: Math.floor(Date.now()/1000), content, tags }, sk);

async function pub(label, ev) {
  try {
    await Promise.all(pool.publish([URL], ev));
    console.log(`✓ ${label}`);
  } catch (e) {
    const kind = e instanceof PaymentUnavailableError ? `PaymentUnavailableError(${e.reason})` : e.constructor.name;
    console.log(`✗ ${label}\n    ${kind}: ${e.message}`);
  }
  console.log(`    정책 학습 상태: ${JSON.stringify(pool.getPolicy(URL).kind)}`);
}

await pub('① 플레인 노트 (무료)', mk([], 'paidpool probe free'));
await pub('② p 태그 (유료, 지불수단 없음)', mk([['p','a'.repeat(64)]], 'paidpool probe paid'));
await pub('③ 다시 p 태그 — 이미 유료로 학습됐으니 왕복 없이 즉시 거부', mk([['p','b'.repeat(64)]], 'again'));

const t = pool.getPolicy(URL);
if (t.kind === 'paid') {
  console.log('\n학습된 조건:', JSON.stringify({
    kinds: t.terms.rules[0]?.kinds, tags: t.terms.rules[0]?.tags,
    amount: t.terms.rules[0]?.amount, methods: t.terms.methods.map(m => m.type),
    envelope: t.terms.envelopeInEventMessage,
  }));
}
pool.close([URL]);

# @nostr-paywall/client

유료 nostr 릴레이에 **결제 봉투를 자동으로 붙여주는** `SimplePool` 드롭인 교체.

```ts
import { PaidPool, PaymentUnavailableError } from '@nostr-paywall/client';

const pool = new PaidPool({
  payer: (relayUrl) => async (req) => {
    // req: { relayUrl, event, terms, amountMsat }
    // 앱이 지갑을 갖는다. 안 낼 거면 null 을 돌려주면 된다.
    return await myWallet.makeEnvelope(req);
  },
});

// 이후는 SimplePool 과 완전히 동일
await Promise.all(pool.publish(relays, event));
```

## 동작

- **모르는 릴레이** → 표준 2원소 EVENT 로 보낸다(생태계 무영향). 성공해도 "무료"라
  단정하지 않는다 — 플레인 노트는 유료 릴레이도 그냥 받아주기 때문.
- **`payment-required` 를 받으면** 그때 NIP-11 을 읽어 조건을 학습하고, 결제해서 재발행한다.
  선제적으로 NIP-11 을 읽는 클라는 없으므로 **거부당한 뒤에 읽는 게** 맞다.
- **학습 후** → 술어를 로컬 평가해 과금 대상만 처음부터 3원소로 보낸다(왕복 1회).
  무과금 이벤트엔 돈을 쓰지 않는다.

## 실패는 구별해서 알려라

지불 수단이 없거나 거부되면 그 릴레이 항목만 `PaymentUnavailableError` 로 reject 된다.

```ts
const results = await Promise.allSettled(pool.publish(relays, event));
for (const r of results) {
  if (r.status === 'rejected' && r.reason instanceof PaymentUnavailableError) {
    // reason: 'no-payer' | 'declined' | 'failed' | 'unsupported'
    toast(`이 답글은 ${r.reason.relayUrl} 에 전달되지 않았습니다`);
  }
}
```

⚠️ **이걸 일반 오류와 뭉개면 안 된다.** 유료 릴레이는 보통 상대의 inbox 릴레이라,
뭉개면 "답글이 상대에게 전달 안 됐는데 UI 는 성공"이라는 조용한 실패가 된다.

설계 문서: https://github.com/tajava2006/nostr-paywall

> PoC. mainnet 미검증.

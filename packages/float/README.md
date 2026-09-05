# @nostr-paywall/float

유료 nostr 릴레이용 **클라이언트 ecash float**. NWC 로 한 번 충전하고 이벤트당 1 sat 씩 쓴다.

```ts
import { EcashFloat, createFloatPayer, createDefaultStore } from '@nostr-paywall/float';
import { PaidPool } from '@nostr-paywall/client';

const float = new EcashFloat({
  store: createDefaultStore(),          // 브라우저/Tauri → IndexedDB, Node → 파일 경로
  funding: {
    payInvoice: (bolt11) => app.wallet.payInvoice(bolt11),   // 충전 (NWC pay_invoice)
    makeInvoice: (sats) => app.wallet.makeInvoice(sats),     // 환불 (NWC make_invoice)
  },
  limits: { maxFloatSats: 500, maxTopUpPerPeriodSats: 2000 },
  onTopUpRequired: async ({ sats }) => confirm(`${sats} sat 충전할까요?`),
});

const pool = new PaidPool({ payer: createFloatPayer(float) });
```

## 왜 라이브러리가 돈을 갖나

NWC 코어에 keysend 가 없어서(NIP-47), 릴레이가 무엇을 받든 앱이 직접 낼 수는 없다.
**민트 견적(NUT-04)이 bolt11 을 주므로** `pay_invoice` 하나로 ecash 를 살 수 있고,
그게 레일 무관성을 얻는 유일한 경로다. 앱은 인보이스 결제/발행 두 개만 제공하면 된다.

## 안전

- **`autoTopUp` 기본 false.** 라이브러리 init 만으로 유저 돈이 나가면 안 된다.
  `onTopUpRequired` 로 앱이 물어보거나, 명시적으로 켜야 한다.
- **한도는 라이브러리 자체 회계다. 암호학적 보증이 아니다.** 진짜 하드캡은
  전용 NWC 커넥션 예산에서만 나온다.
- **float 을 작게 유지하라.** 브라우저 저장소는 내구성이 없고(Safari ITP 는 7일)
  ecash 는 베어러라 XSS 면 그대로 도난이다. 상한이 곧 노출 한도다.
- **단일 writer 락.** 탭 두 개가 같은 proofs 를 쓰면 한쪽이 실패하고, 더 나쁘게는
  서로의 저장분을 덮어써 ecash 를 잃는다. Web Locks 로 막고, 없으면 프로세스 내 직렬화.
- **pending 을 버리지 않는다.** 릴레이 응답을 못 받은 토큰은 보관했다가
  `reconcile()` 이 민트에 물어(NUT-07) 미사용이면 되살린다. 민트에 못 물어보면 **보류**한다.

설계 문서: https://github.com/tajava2006/nostr-paywall

> PoC. mainnet 미검증.

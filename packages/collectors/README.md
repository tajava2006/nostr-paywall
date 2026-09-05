# @nostr-paywall/collectors

유료 nostr 릴레이의 **수납 어댑터**. 실제로 돈을 만지는 유일한 층이다.

```ts
import { CashuCollector, assertZeroFeeMints } from '@nostr-paywall/collectors';

const collector = new CashuCollector({ allowedMints: ['https://mint.example'] });
await collector.init();                     // 부팅 게이트 — 아래 참조

const v = await collector.validate(envelope, ctx);   // 돈을 건드리지 않는다
if (v.ok) await collector.collect(envelope, ctx);    // 여기서만 움직인다
```

`validate` 와 `collect` 를 나눈 게 핵심이다. 결제 외 모든 거부 사유를 먼저 걸러낸 뒤에만
돈을 건드릴 수 있게 순서가 타입 수준에서 강제된다.

## ⚠️ 민트는 `input_fee_ppk == 0` 이어야 한다

NUT-02 상 `fees = ceil(sum(input_fee_ppk)/1000)` 이고 `sum(inputs) - fees == sum(outputs)` 다.
`ppk=100` 이면 입력 1~10개당 1 sat 이라 **1 sat 결제는 swap 자체가 성립하지 않는다**.
`init()` 이 이걸 검사해서 아니면 던진다 — 설정 실수 하나로 모든 수납이 조용히 0원이 되는 걸 막는다.

설계 문서: https://github.com/tajava2006/nostr-paywall

> PoC. mainnet 미검증.

# @nostr-paywall/protocol

이벤트 단위 마이크로페이먼트 유료 nostr 릴레이의 **순수 프로토콜 층**. 런타임 의존성 0.

릴레이와 클라이언트가 **같은 코드**를 쓴다. 두 벌이면 "클라는 공짜라 믿고 보내는데
릴레이는 과금이라 거부"처럼 조용히 갈린다.

```ts
import { priceFor, parsePaymentTerms, takePaymentEnvelope, parseOkReason } from '@nostr-paywall/protocol';

// 릴레이의 NIP-11 문서에서 조건을 읽는다 (거부당한 뒤 lazy fetch 하면 된다)
const terms = parsePaymentTerms(await fetchRelayInformation(url));

// 이 이벤트를 이 릴레이에 올릴 때 돈을 내야 하는가
const price = priceFor(event, terms);   // { charge: true, amountMsat: 1000, rule } | { charge: false }
```

- **과금 술어** — 정책은 코드가 아니라 릴레이가 광고한 `terms` 에 있다. 클라는 *릴레이의* 정책을 평가한다
- **NIP-11 파서** — 신뢰할 수 없는 원격 JSON 이라 절대 throw 하지 않는다. 못 읽으면 무료로 취급
- **EVENT 봉투** — `["EVENT", <event>, <payment>]` 조립/해체
- **OK 규약** — 접두사 조립(릴레이)과 해석(클라)을 한 파일에 둬서 문자열이 갈리는 걸 막는다

설계 문서: https://github.com/tajava2006/nostr-paywall

> PoC. mainnet 미검증.

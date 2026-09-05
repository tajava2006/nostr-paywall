# @nostr-paywall/relay-guard

유료 nostr 릴레이의 **결제 원장과 가드**. `node:sqlite` 라 네이티브 의존성 0.

> ⚠️ **Node 22.5+ 필요** (`node:sqlite` 내장 시점). **24 이상 권장** — 그보다 낮으면
> `--experimental-sqlite` 플래그가 필요하다. 버전이 낮으면 부팅 시
> `ERR_UNKNOWN_BUILTIN_MODULE: No such built-in module: node:sqlite` 로 죽는다.
> pm2/systemd 로 돌린다면 **그 데몬이 쓰는 Node 버전**을 확인할 것 — 셸에서 바꿔도
> 데몬이 옛 버전으로 떠 있으면 자식 프로세스도 옛 버전을 물려받는다.

```ts
import { PaymentGuard, SqlitePaymentRepository } from '@nostr-paywall/relay-guard';

const guard = new PaymentGuard({ terms, collectors: [collector], repository: new SqlitePaymentRepository(path) });
await guard.init();

const outcome = await guard.check(event, envelope);
// 'free' | 'already-paid' | 'collected' | 'reject'(okMessage 를 그대로 OK 에 실으면 된다)
```

**훅 비의존**이다 — 특정 릴레이 구현을 import 하지 않으므로 어디에도 얹을 수 있다.

## 원장이 지키는 것 셋

1. **이중사용** — proof secret 하나는 한 이벤트만 산다
2. **멱등(유저 보호)** — 같은 이벤트를 두 번 보내도 두 번 과금되지 않는다.
   클라가 봉투를 잃고 새 proofs 로 재시도해도 잡힌다
3. **자산 보관** — 수납한 proofs 는 베어러다. **이 원장이 유일한 사본**이라
   감사 로그가 아니라 자산 원장이다. 파일을 잃으면 걷은 돈이 증발한다

설계 문서: https://github.com/tajava2006/nostr-paywall

> PoC. mainnet 미검증.

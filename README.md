# nostr-paywall

이벤트 단위 마이크로페이먼트 유료 nostr 릴레이. **구독이 아니라 이벤트 1건 = 1 sat.**

구독형 유료 릴레이가 원리적으로 못 푸는 세 가지를 베어러 결제로 푼다:

1. **다계정** — nostr는 용도별 계정 분리가 흔한데 구독은 npub 단위다
2. **일회용 키** — NIP-17 DM은 gift wrap을 매번 새 키로 서명한다. 구독 대상이 없다
3. **소액** — 월 단위 결제가 최소 단위다

읽기는 무료. 쓰기 중 **타인에게 노티가 가거나 자동 노출되는 것**만 과금한다.

> **설계 문서 = [PLAN.md](PLAN.md)가 진실.** 결정·근거·미해결 항목이 전부 거기 있다.

## 구성

```
packages/protocol/   과금 술어 · NIP-11 파서 · 봉투 · 메시지/OK 직렬화   ← 릴레이와 클라의 공유 진실
packages/relay-guard/  (예정) 릴레이 플러그인 · Repository · Collector
packages/collectors/   (예정) cashu / ln-keysend 어댑터
packages/client/       (예정) PaidPool extends SimplePool
packages/float/        (예정) ecash float — 영구저장 · 단일 writer 락 · NWC 충전/환불
apps/demo/             (예정) 데모 웹클라
```

릴레이 본체는 여기 없다 — `nostr-relay-nestjs` 포크다.

## 개발

```sh
pnpm install
pnpm test        # 전체
pnpm typecheck
```

## 상태

PoC. mainnet 미검증. M1(`protocol`)까지 완료.

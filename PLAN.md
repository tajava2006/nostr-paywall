# nostr-paywall — 이벤트 단위 마이크로페이먼트 유료 릴레이

> 상태: **초안 v0.1** (2026-09-02). 코드 0줄. 이 문서가 진실.
> 목표: 구독이 아니라 **이벤트 1건 = 1 sat**. 스팸 비용화 + 릴레이 수익화 PoC.

## 0. 왜

구독형 유료 릴레이는 세 가지를 원리적으로 못 푼다:

1. **다계정** — nostr는 용도별 계정 분리가 흔한데 구독은 npub 단위다.
2. **일회용 키** — NIP-17 DM은 gift wrap(kind 1059)을 매번 새 키로 서명한다. 구독 대상이 없다.
3. **소액** — 월 단위 결제가 최소 단위다.

셋 다 **베어러(bearer) 결제**로만 풀린다. 그래서 이벤트 단위 마이크로페이먼트.

**한계도 명시해둔다**: 쓰기 과금은 *스팸 저항*을 사지 *인프라*를 사지 않는다. 릴레이의 실제 비용은
읽기 대역폭(egress)이고 그건 무료로 남는다. 유료 쓰기가 사주는 건 (a) 저장 증가량 유계화,
(b) LLM/WoT 필터링 CPU 제거 두 가지다. 이 이상을 주장하지 말 것.

---

## 1. 확정 결정

| # | 결정 | 근거 |
|---|---|---|
| D1 | 읽기 무료. 쓰기 중 **타인에게 노출/노티가 가는 것**만 과금 | 플레인 노트는 스팸이 될 수 없음(글로벌 피드 아무도 안 봄) |
| D2 | 결제는 **`["EVENT", <event>, <payment>]` 단일 메시지**의 3번째 원소 | 원자적. pending/orphan 상태·TTL·GC 전부 불필요 |
| D3 | payment는 **서명 이벤트가 아니라 평범한 JSON 객체** | 연결할 키가 없어서 익명성 ↑, 코드 ↓ |
| D4 | **Cashu 1순위**, LN keysend는 시연용, Ark 보류 | 1 sat에 라우팅 수수료 2~3 sat는 배보다 배꼽 |
| D5 | Cashu 토큰은 **잠그지 않는다(unlocked)**. ~~P2PK-lock~~ | **2026-09-05 반전** — §4.1. P2PK는 릴레이 급사 시 토큰을 영구 사망시키고 검증 6건을 부른다 |
| D6 | 처리 순서 = **결제 외 전 거부사유 검사 → swap → 저장** | Cashu에서 구속력 있는 유효성 확인 = swap 그 자체 |
| D7 | 가격은 v1 **일괄 1 sat** | PoC. kind별 차등·수신자별 가격은 v2 |
| D8 | terms 발견은 **NIP-11을 거부 응답 후 lazy fetch** | 아무도 NIP-11을 선제적으로 안 읽음 (§3.5) |
| D9 | 레포 1개(모노레포), 릴레이는 `nostr-relay-nestjs` 포크 | 프로토콜 양쪽 절반이 같이 요동침 |
| D10 | 클라 라이브러리가 **ecash float을 직접 보유**. 앱은 **URI가 아니라 `payInvoice`/`makeInvoice` 콜백**을 준다 | §6 — NWC 코어에 keysend가 없어 float이 레일 무관성의 **유일한** 경로. URI를 받으면 앱 전체 예산을 상속하고 NWC 클라를 재구현하게 됨 |
| D11 | LN 넌스는 저장하지 말고 **파생**: `HMAC(client_secret, event_id ‖ node_pubkey)` | §3.7 — 멱등과 예측불가가 동시에 성립 |
| D12 | 멱등은 **유저 보호 방향**. Cashu는 `proof_secret` 키, LN은 파생 넌스 | §3.6 — 재시도 시 동일 봉투 재전송 규약 |
| D13 | 민트 allowlist는 **`input_fee_ppk == 0`** 인 민트만 | **1 sat 가격의 생사가 걸림** — §4.1. ppk=100이면 수수료가 1 sat이라 1 sat proof는 swap 자체가 불가(실측) |
| D14 | Cashu 봉투는 **인코딩된 토큰 문자열**(`cashuB…`). raw proof 배열 아님 | §3.2 — 배열로 실으면 릴레이 swap이 입력 0개로 조립됨(실측). 문자열이라 JSON 왕복 무손실 |

---

## 2. 과금 술어

```
과금 = (kind ∈ ALLOWLIST) AND (∃ tag: name ∈ {"e", "p"})
ALLOWLIST = {1, 4, 6, 7, 16, 1111, 1059}
```

**allowlist인 이유**: 모르는 kind는 공짜(fail-open). 예외 목록(blacklist)보다 짧고, kind 3(팔로우
리스트)·10002·30000번대(셋)의 구조적 `p` 태그 수백 개가 자동으로 빠진다. 대가는 **스팸이 새 kind로
이주할 수 있다**는 것 — 주기적 목록 갱신이 유지보수 항목이다.

| kind | 근거 |
|---|---|
| 1 | 답글/멘션. [NIP-10](../nips/10.md) — 답글은 부모의 `p` 태그를 전부 물려받음 |
| 1111 | 코멘트. [NIP-22](../nips/22.md) |
| 4 | 레거시 DM |
| 1059 | gift wrap. [NIP-17](../nips/17.md#L23) — **구독 모델이 못 푸는 바로 그 케이스** |
| 6, 16 | 리포스트. [NIP-18](../nips/18.md#L9) — `e`+`p`로 노티 + 팔로워 피드 자동 렌더 |
| 7 | 리액션. [NIP-25](../nips/25.md#L10) + **[NIP-30](../nips/30.md#L9)이 kind 7에 커스텀 이모지 허용** → `<image-url>`이 임의 URL이라 **공격자가 고른 이미지가 상대 알림 탭에 렌더됨** |

**제외 근거**:
- `q` 태그 단독(=`e`/`p` 없음)은 과금 안 함. 인용당한 사람은 알지도 못하고, 자동 렌더는 인용한
  사람의 팔로워 피드에서 일어난다. 주의력 절도가 아님.
- kind 1111 중 웹URL/팟캐스트 댓글은 `I`/`K`/`i`/`k`만 있고 `e`/`p`가 없다
  ([22.md](../nips/22.md#L135)) → 아무도 노티 안 받음 → 술어에서 자동 탈락. 의도한 동작.

술어는 **순수 함수**로 `protocol` 패키지에 두고 릴레이/클라가 같은 코드를 쓴다. 클라가 로컬에서
"이 릴레이가 이 이벤트에 돈을 받을까"를 판정할 수 있어야 1-shot 발행이 된다.

---

## 3. 프로토콜

### 3.1 EVENT 메시지 확장

```
["EVENT", <event>, <payment>]
```

- 3번째 원소는 **유료 릴레이에만** 붙인다. 나머지 릴레이엔 표준 2원소를 보낸다 → 생태계 무영향.
- NIP-01은 추가 원소를 금지하지 않는다([01.md:117](../nips/01.md#L117)).
- ✅ **V2 확인됨 (2026-09-02)**: `@nostr-relay/validator`는 3원소를 **거부한다**.
  [event-message.schema.ts](../nostr-relay/packages/validator/src/schemas/event-message.schema.ts)의
  `z.tuple([z.literal(MessageType.EVENT), createEventSchema(options)])` — zod tuple은 여분 원소를
  거부한다(실측: `too_big / Array must contain at most 2 element(s)`. `.rest(z.unknown())`을 붙이면 통과).
  **해결은 §5.1** — 검증 *전에* 봉투를 떼어내므로 `@nostr-relay/*` 패키지 포크는 불필요하다.

### 3.2 payment 봉투

```jsonc
// Cashu
{
  "v": 1,
  "method": "cashu",
  "mint": "https://mint.example.com",
  "unit": "sat",
  // ★ 인코딩된 NUT-00 토큰 문자열. raw proof 배열이 아니다(D14).
  //   배열로 실으면 릴레이 swap 이 입력 0개로 조립돼 실패한다 — v2 keyset 짧은 id
  //   해석이 토큰 디코딩에서 일어나기 때문(실측 "Inputs: 0, Outputs: 0").
  //   덤으로 cashu-ts v4 의 Proof.amount 가 Amount(bigint 래퍼)라 JSON 직렬화 시
  //   숫자가 문자열로 변하는 함정도 피한다. 문자열은 왕복 무손실.
  "token": "cashuB…"        // unlocked — P2PK 로 잠그지 않는다(D5)
}

// LN keysend
{
  "v": 1,
  "method": "ln-keysend",
  "node": "03def…",      // 릴레이 노드가 여럿일 때 지목
  "nonce": "<64-hex>"    // preimage = sha256(event_id ‖ node_pubkey ‖ nonce)
}
```

**event_id 바인딩은 왜 필요한가**: 익명 결제에는 크레딧할 계정이 없다. 결제가 스스로 목적을 밝혀야
한다. 단일 메시지에선 **구조가 곧 바인딩**이라 Cashu 쪽은 추가 필드가 필요 없다(같은 메시지 안에
있으므로). 이중사용 방지는 릴레이 DB의 `UNIQUE(proof_secret)`가 담당한다.

LN은 결제가 이벤트보다 먼저 도착하므로 명시적 바인딩이 필요하다 → 위의 결정론적 preimage.
`nonce`는 §3.7 참조.

### 3.3 OK 응답 규약

| 응답 | 의미 |
|---|---|
| `["OK", id, true, ""]` | 저장 완료 |
| `["OK", id, true, "duplicate: already have this event"]` | 이미 있음 — **무과금** |
| `["OK", id, false, "payment-required: 1 sat per tagged note"]` | 결제 필요 (첫 접촉) |
| `["OK", id, false, "payment-invalid: proof already spent"]` | 토큰 불량 |
| `["OK", id, false, "payment-invalid: mint not allowed"]` | allowlist 밖 민트 (H1) |
| `["OK", id, false, "error: storage failed; refund=cashuA…"]` | **결제 후 저장 실패 → proofs 반환** |

`payment-required`는 NIP-01 표준 접두사 8종에 없다([01.md:180](../nips/01.md#L180)). 우리 클라가
소비자라 문제없고, **사람이 읽을 문장을 반드시 넣어라** — 일반 클라(Amethyst 등)는 이 문자열을
에러 토스트에 그대로 띄우므로 수동 결제 폴백이 공짜로 생긴다.

### 3.4 처리 순서 (릴레이) — **순서가 곧 안전장치**

```
1. 이벤트 파싱·서명 검증·크기·created_at 등 기본 검증
2. 과금 술어 평가 → 무과금이면 바로 6
3. 중복 확인 → 있으면 duplicate로 OK true, 종료 (무과금)
4. payment 봉투 파싱 + **H1 민트 allowlist** + **H1b ppk==0** (§4.1)
5. ── 여기까지 통과해야 돈을 건드린다 ──
   swap (Cashu) / 정산 확인 (LN)
6. 저장
7. 저장 실패 시 fresh proofs를 OK 메시지로 반환
```

v1은 동기 swap. 배치 정산은 P2PK 가 전제라 v2 (§4.1 v2 블록).

- **1~4를 먼저 하는 이유**: 거부할 이벤트에 돈을 받으면 안 된다. 결제 후에 실패 가능한 건 인프라
  장애뿐이고 그건 7이 덮는다.
- **"저장 먼저, 결제 나중"은 안 된다**: Cashu에서 토큰 유효성을 구속력 있게 확인하는 유일한 방법이
  swap(수령) 그 자체다. `checkstate` 조회는 TOCTOU라 게이트로 못 쓴다. 무검증 저장 = 페이월 무력화.
- **5 이전에 릴레이가 죽으면 토큰은 손도 안 댄 상태** → 클라가 계속 소유. 환불 코드 0줄. (§4.1)

### 3.5 terms 발견 — NIP-11 lazy fetch

현실적으로 아무도 NIP-11을 선제적으로 안 읽는다. 그래서 **거부당한 다음에 읽는다**:

```
1. 클라가 그냥 발행 (2원소)
2. ["OK", id, false, "payment-required: …"]
3. 클라가 그 릴레이의 NIP-11 문서를 fetch (nostr-tools에 fetchRelayInformation 있음 — nip11.ts:11)
4. terms를 메모리 캐시에 저장 (릴레이당 1회, 영구)
5. 결제 붙여서 재발행
```

NIP-11이 **웹소켓과 같은 URL**이라 별도 엔드포인트 설정이 필요 없다. HTTP fetch 1회, 이후 영구 캐시.
"NIP-11은 아무도 안 읽는다"는 지적은 *선제적* 읽기에만 해당하고, 반응적 읽기엔 오히려 최적이다.

**NIP-11 확장** (기존 `fees.publication`이 이미 있다 — [11.md:170](../nips/11.md#L170)):

```jsonc
{
  "limitation": { "restricted_writes": true },
  "fees": {
    "publication": [
      {
        "kinds": [1, 4, 6, 7, 16, 1111, 1059],
        "tags": ["e", "p"],          // ★ 확장: 이 중 하나라도 있으면 과금
        "amount": 1000, "unit": "msats"
      }
    ]
  },
  "payment_v1": {                     // ★ 확장: 결제 수단
    "envelope_in_event_message": true,
    "methods": [
      { "type": "cashu", "unit": "sat",
        "mints": ["https://mint.example.com"] },   // 전부 input_fee_ppk==0 이어야 함 (D13)
      { "type": "ln-keysend", "unit": "msat", "node": "03def…" }
    ]
  }
}
```

술어: `kind ∈ kinds` **AND** `∃ tag name ∈ tags`. `tags` 없으면 kind만 (= 바닐라 NIP-11 하위호환).
블록 여러 개면 first match wins. **표현식 언어 만들지 말 것** — 이게 v1 규칙을 정확히 표현하는 최소치다.

### 3.6 멱등성 — **유저를 보호하는 방향으로**

목표는 릴레이 방어가 아니라 **"클라가 같은 이벤트를 같은 릴레이에 두 번 보내도 두 번 과금되지 않는다"**이다.

- **재시도 규약**: 클라는 확정 OK를 받기 전까지 봉투를 보관하고, 재시도 시 **바이트 동일한 봉투를
  재전송**한다. (재시도 큐가 어차피 하는 일)
- **Cashu**: 릴레이는 `proof_secret → {event_id, state}`를 기록한다.
  - 같은 시크릿 + **같은** event_id → 멱등 리플레이. 저장만 하고 **재과금 없음**
  - 같은 시크릿 + **다른** event_id → 거부 (이중사용 시도)
  - 처음 보는 시크릿 → 정상 수납
- **LN**: §3.7의 파생 넌스 덕에 재시도가 **같은 payment hash**를 만든다. 이미 settled된 인보이스에
  새 HTLC가 오면 LND가 `ResultInvoiceAlreadySettled`로 **거부**한다
  ([invoiceregistry.go:1293](../lnd/invoices/invoiceregistry.go#L1293)) → 유저 돈이 안 나간다.
- 이미 저장된 event_id 재요청: `duplicate:`로 무과금 통과.
  ⚠️ 이건 **미저장 이벤트 존재 여부 프로브**를 연다. 1 sat짜리 관심사는 아니지만 기록해둠.

### 3.7 LN preimage nonce — 저장하지 말고 파생

```
client_nonce = HMAC-SHA256(client_secret, event_id ‖ relay_node_pubkey)
preimage     = sha256(event_id ‖ relay_node_pubkey ‖ client_nonce)
```

`client_secret`은 32바이트 하나. 지갑/NWC 연결과 같은 수명으로 **한 번만 보관**한다.

- `event_id` → **이 이벤트 전용** 결제
- `relay_node_pubkey` → 릴레이별로 갈림
- `client_nonce` → **라우팅 노드가 예측 못 한다**(`client_secret`을 모르므로). 넌스는 keysend
  TLV(최종 홉만 읽는 onion 안)에 실어 릴레이만 안다
- **파생이 핵심**: 넌스를 랜덤으로 뽑으면 "멱등하려면 넌스를 N개 저장해야 하고, 잃으면 재결제"라는
  긴장이 생긴다. 파생하면 언제든 재계산되므로 **멱등과 예측불가가 동시에** 성립하고 백업 대상은
  시크릿 1개뿐이다.
- keysend는 발신자가 preimage를 고른다 — [record/experimental.go:5](../lnd/record/experimental.go#L5)
  `KeySendType = 5482373484`.

---

## 4. 레일

### 4.1 Cashu (1순위) — **v1은 unlocked** (2026-09-05 반전)

봉투에는 **평범한 unlocked proof**를 싣는다. P2PK로 잠그지 않는다.

**왜 P2PK를 뺐나** — 원래 논거는 "잠가야 보낸 사람이 이중지불 못 하고, 그래야 swap을 저장 직전까지
미룰 수 있다"였다. 그 전제 자체는 참으로 확인됐지만(아래 V1), **결론이 틀렸다**:

1. **레이스를 져도 릴레이 손해가 0이다.** 클라가 먼저 회수해가면 swap이 실패하고 릴레이는 그냥
   이벤트를 저장 안 하면 끝이다. "즉시 swap 압박"이 실재하지 않으므로 unlocked에서도 §3.4 순서를
   그대로 지킬 수 있다. 막을 필요가 없는 걸 막고 있었다.
2. **P2PK는 회수 불능을 만든다.** 릴레이가 봉투를 받고 swap 전에 죽으면 그 토큰은 릴레이 키로 잠긴 채
   **영구 사망**한다 — 클라에게 회수 경로가 아예 없다. unlocked면 클라가 자기 것을 다시 swap해서
   회수하면 그만이다. 릴레이 급사는 실제로 일어나는 시나리오다.
3. **검증 6건이 통째로 P2PK 때문에 존재했다.** 특히 H2는 겉보기 정상인데 조용히 뚫린다.
   1 sat 유출을 막자고 보안 체크 6개를 사는 거래다.

**대신 잃는 것 (명시)**: 아래 DLEQ 배치 정산이 죽는다(지연 정산은 P2PK 없이는 이중지불 가능).
→ **swap은 동기**, 이벤트당 민트 왕복 1회. v1 PoC엔 수용 가능하고, 지연이 실제 문제가 되면
그때 P2PK와 검증 체크리스트를 **같이** 다시 사면 된다.

**남는 규칙 3개**:
- **H1(민트 allowlist)은 유지** — 이유가 다르다. P2PK 방어가 아니라 "우리가 상환 가능한 민트여야
  한다"는 경제적 요건이다.
- **H1b(신설, 2026-09-05): allowlist 민트는 `input_fee_ppk == 0` 이어야 한다.** 아래 참조.
- 봉투가 이제 평문 베어러다 → **봉투를 로그에 찍지 마라.**

#### ⚠️ H1b — swap 수수료가 1 sat 가격을 죽인다 (실측)

내가 "Cashu는 수수료 0"이라고 한 건 **틀렸다.** 민트는 NUT-02 `input_fee_ppk` 로 swap 수수료를
매길 수 있고, 공식은:

```
fees = ceil(sum(input_fee_ppk) / 1000)      # 02.md:43-50
sum(inputs) - fees == sum(outputs)
```

`ppk=100` 이면 **입력 1~10개당 1 sat**. 즉 1 sat proof 는 `1 - 1 = 0` 출력이라 **swap 자체가
성립하지 않는다.** testnut 실측:

| 보낸 금액 | 릴레이 수납 | 결과 |
|---|---|---|
| 1 sat | — | ✗ `Inputs: 0, Outputs: 0` |
| 2 sat | 1 sat | ✓ (수수료 1) |
| 64 sat | 63 sat | ✓ (수수료 1) |

공개 민트 실측 (`/v1/keysets` 의 활성 sat 키셋):

| 민트 | `input_fee_ppk` | 1 sat 가능 |
|---|---|---|
| `mint.minibits.cash/Bitcoin` | **0** | ✅ |
| `21mint.me` | **0** | ✅ |
| `testnut.cashu.space` | 100 | ❌ |
| `mint.coinos.io` | 100 | ❌ |

→ 릴레이는 부팅 시 allowlist 민트의 활성 sat 키셋을 조회해 **ppk≠0 이면 거부**해야 한다.
설정 실수 하나로 모든 수납이 조용히 0원이 되는 종류의 함정이다.

**환불**: 잠기지 않았으므로 릴레이가 죽든 말든 클라가 스스로 회수한다. 릴레이가 swap 후 저장에
실패한 경우에만 fresh proofs를 OK 메시지로 돌려준다(§3.4-7).

---

<details>
<summary><b>v2 참고 — P2PK 경로 (지연 때문에 배치 정산이 필요해지면 여기로 돌아온다)</b></summary>

#### ✅ V1 확인 결과 (2026-09-02) — 전제는 참

NUT-11 P2PK는 `Secret.data`의 펍키로 **Schnorr 서명을 요구**하고 그 검증은 민트가
강제한다([11.md:11](../nuts/11.md#L11), [11.md:21](../nuts/11.md#L21)). 보낸 사람은 시크릿을 알아도
서명을 못 만든다 → 보낸 사람의 이중지불이 막힌다 → 지연 정산이 안전해진다.
NIP-61이 proofs를 공개 이벤트에 평문으로 싣는 근거도 이것이다([61.md:50](../nips/61.md#L50)).
펍키는 compressed secp256k1 형식([11.md:264](../nuts/11.md#L264)).

#### ⚠️ 검증 체크리스트 — 채택 시 하나라도 빠지면 무료 발행 구멍

`data == 내 펍키`만 확인하면 **전부 뚫린다.** 봉투 수령 시 릴레이가 반드시 검사할 것:

| # | 검사 | 안 하면 | 근거 |
|---|---|---|---|
| **H1** | `mint`가 **릴레이 allowlist**에 있는가 + 그 민트가 NUT-10/11 지원(`/v1/info`의 `nuts["11"].supported`)인가 | **민트가 P2PK를 모르면 proof는 그냥 anyone-can-spend가 된다.** 잠금이 장식이 됨 | [10.md:15](../nuts/10.md#L15), [11.md:13](../nuts/11.md#L13), [06.md:81](../nuts/06.md#L81) |
| **H2** | `pubkeys` 태그 **부재** | `pubkeys`가 있으면 `data` 또는 그 목록 중 **아무 키 1개** 서명이면 통과(기본 `n_sigs=1`). 클라가 자기 키를 끼워넣으면 즉시 1-of-2 → **클라도 쓸 수 있다** | [11.md:199](../nuts/11.md#L199), [11.md:203](../nuts/11.md#L203) |
| **H3** | `locktime` 태그 **부재** | locktime 경과 시 lock이 만료된다. `refund` 태그가 있으면 그 키들이, **`refund`가 없으면 아무나 witness 없이** 쓸 수 있다. 클라가 `now+5s`를 박으면 5초 뒤 공짜 | [11.md:181-183](../nuts/11.md#L181), [11.md:186](../nuts/11.md#L186) |
| **H4** | `refund` / `n_sigs_refund` **부재** | H3의 짝. 심층방어로 같이 거부 | [11.md:213](../nuts/11.md#L213) |
| **H5** | `sigflag`가 부재이거나 `SIG_INPUTS` | `SIG_ALL`이면 릴레이의 swap 서명이 출력까지 덮어야 해서 collector가 복잡해진다. v1은 거부 | [11.md:97-98](../nuts/11.md#L97) |
| **H6** | `data` 비교는 **소문자 x-coordinate**로 | `02`/`03` y-parity 프리픽스는 **무시하고 비교**하는 게 규격이다. 문자열 전체 비교하면 `03…`으로 온 정상 토큰을 오거부한다(안전하지만 버그) | [11.md:268](../nuts/11.md#L268) |

> **H2가 제일 위험하다.** 겉보기엔 `data`가 우리 키라 정상인데 `pubkeys`에 클라 키가 하나 끼어 있으면
> 클라가 언제든 회수할 수 있다. 순진한 구현이 정확히 여기서 뚫린다.

원칙: **`tags`는 화이트리스트**로 간다 — `sigflag: SIG_INPUTS` 외의 태그가 하나라도 있으면 거부.
위 표를 개별 조건으로 나열하지 말고 "허용 태그 집합" 하나로 구현할 것(새 NUT가 태그를 추가해도 안전).

#### 🎁 뜻밖의 수확 — DLEQ로 민트 왕복을 이벤트 경로에서 뺄 수 있다

NUT-11이 use case로 **명시**한다([11.md:302-303](../nuts/11.md#L302)):

> - Final offline-receiver payments that can't be double-spent when combined with an offline signature check mechanism like DLEQ proofs
> - **Receiver of locked ecash can defer and batch multiple mint round trips for receiving proofs (requires DLEQ)**

NUT-12 DLEQ는 민트의 공개키만으로 **오프라인에서** 그 proof가 진짜 민트 서명인지 검증한다
([12.md:1](../nuts/12.md#L1)). P2PK(이중지불 불가) + DLEQ(위조 불가) + allowlist 민트(H1)가 모이면:

```
DLEQ 오프라인 검증 (네트워크 0) → 저장 → swap 은 나중에 배치
```

**이벤트당 민트 왕복 ~50–200ms가 사라진다.** 서드파티 민트를 쓰면서도 지연이 로컬 DB 수준이 된다
→ **자체 민트를 돌릴 이유(지연)가 없어진다.** float 부채도 없다. §3.4의 순서가 이 모드에선
"swap → 저장"이 아니라 "**DLEQ 검증 → 저장 → 배치 swap**"이 된다.

전제: H1이 **load-bearing**이다. 민트가 P2PK를 안 지키면 지연 구간 전체가 열린다.
그리고 배치 swap 실패 시엔 이미 저장한 뒤라 돈만 잃는다 — 그건 **민트 리스크**지 프로토콜 구멍이 아니고,
1 sat 단위라 수용 가능하다. v1은 동기 swap으로 만들고 **배치 모드는 노브로 준비만** 해둔다.

#### cashu-ts API 매핑 (✅ V8 — 직접 구현 분량 거의 없음)

| 용도 | API ([`cashu-ts/src/crypto/`](../cashu-ts/src/crypto/)) |
|---|---|
| 클라: P2PK 잠금 생성 | `createP2PKsecret(pubkey, tags?)` — [NUT11.ts:166](../cashu-ts/src/crypto/NUT11.ts#L166) |
| 릴레이: 서명해서 spend | `signP2PKProofs` / `signP2PKProof` — [NUT11.ts:514](../cashu-ts/src/crypto/NUT11.ts#L514) |
| 릴레이: 자격 키 추출 (H2·H6) | `getP2PKExpectedWitnessPubkeys(secret)` — [NUT11.ts:423](../cashu-ts/src/crypto/NUT11.ts#L423). 정규화(소문자 x-only)까지 해줌 |
| 릴레이: sigflag 확인 (H5) | `getP2PKSigFlag(secret)` — [NUT11.ts:446](../cashu-ts/src/crypto/NUT11.ts#L446) |
| 릴레이: 태그 화이트리스트 (H3·H4) | `parseP2PKSecret` + 직접 판정. `P2PK_KNOWN_TAG_KEYS`([NUT11.ts:146](../cashu-ts/src/crypto/NUT11.ts#L146))는 *인식* 태그 집합이지 우리 정책이 아니다 — 우리 화이트리스트는 `sigflag`뿐 |
| 릴레이: DLEQ 오프라인 검증 | `verifyDLEQProof` / `verifyDLEQProof_reblind` — [NUT12.ts:34](../cashu-ts/src/crypto/NUT12.ts#L34) |

⚠️ `verifyP2PKSpendingConditions`([NUT11.ts:647](../cashu-ts/src/crypto/NUT11.ts#L647))는
"**주어진 witness로 지금 쓸 수 있는가**"를 판정하지 "**나만 쓸 수 있는가**"를 판정하지 않는다.
우리가 필요한 건 후자다 — 파싱·정규화만 라이브러리에 맡기고 **정책 판정은 직접 짠다**.
(참고: 이 함수의 반환 `path`에 `'UNLOCKED'`(= 아무나 spend 가능)이 실제로 존재한다
[NUT11.ts:96](../cashu-ts/src/crypto/NUT11.ts#L96) — H3가 가상의 위험이 아니라는 증거.)

</details>

### 4.2 LN keysend (시연용)

1 sat에 홉당 base fee 1 sat(LND 기본 1000 msat)이라 수수료가 원금 이상이다. **단 릴레이 노드와
직접 채널이면 0이다** → 데모 클라가 채널 하나 열어두는 구성이면 깔끔하게 성립한다.

정산된 1 sat은 `to_local`/`to_remote` 잔고 이동이라 채널 종료 시 보존된다. (BOLT-3 dust trim은
*in-flight HTLC 출력*에만 해당하고, 그 사이 force-close가 나야 1 sat이 수수료로 날아간다 — 무의미.)

**타이밍**: 릴레이 대기 창은 필요 없다. **클라가 keysend 정산 완료를 확인한 뒤에 EVENT를 보낸다.**
그러면 릴레이는 도착 즉시 자기 원장에서 찾는다. 대신 발행 경로에 LN 결제 지연(수 초)이 직렬로 붙는다
— LN이 시연용인 이유 하나 더.

⚠️ **NWC로는 이 레일을 못 쓴다.** NIP-47 코어 메서드는 `pay_invoice`/`make_invoice`/`lookup_invoice`/
`get_balance`/`get_info`가 전부고([47.md:63](../nips/47.md#L63)) keysend는 없다 — 추가 메서드는
확장에서 MAY다([47.md:320](../nips/47.md#L320)). 커스텀 preimage TLV는 더더욱 못 싣는다.
→ **keysend 레일은 LND 직접 접근이 있는 클라 전용**이고, NWC 클라를 받으려면 릴레이가 이벤트별
bolt11을 발급해야 하는데 그건 왕복이 강제돼 1-shot이 죽는다. **이게 §6 float 설계의 직접적 근거다.**

### 4.3 Ark (보류)

1 sat 건당은 우리가 1년 싸운 서브더스트 문제 그 자체다. 건당 결제로 쓰지 말 것.
쓴다면 **충전 레일**로만 — 그건 v1 범위 밖.

---

## 5. 릴레이 측

### 5.1 훅

`nostr-relay-nestjs`는 이미 플러그인 가드 구조다 —
[blacklist-guard.plugin.ts](../nostr-relay-nestjs/src/modules/nostr/plugins/blacklist-guard.plugin.ts):

```ts
interface BeforeHandleEventPlugin {
  beforeHandleEvent(event: Event): BeforeHandleEventResult  // { canHandle, message }
}
```

`@nostr-relay/pow-guard`, `wot-guard`, `or-guard`가 같은 인터페이스로 npm에 있다. 우리 것도
`PaymentGuardPlugin`으로 같은 모양을 내면 이 생태계에 바로 꽂힌다.

### ✅ V3 해결 (2026-09-02) — 봉투 전달 경로

`beforeHandleEvent(event)`는 `event`만 받아서 봉투를 실을 자리가 없다
([plugin.interface.ts:78](../nostr-relay/packages/common/src/interfaces/plugin.interface.ts#L78)).
`HandleMessagePlugin`은 Koa식 미들웨어라 메시지 전체를 받지만
([plugin.interface.ts:42](../nostr-relay/packages/common/src/interfaces/plugin.interface.ts#L42)),
**플러그인은 검증 뒤에 돈다**:

```ts
// nostr-relay-nestjs/src/modules/nostr/services/nostr-relay.service.ts:103-111
const msg = await this.validator.validateIncomingMessage(data);   // ← 106, 여기서 3원소 거부
await this.relay.handleMessage(client, msg);                      // ← 110, 플러그인은 이 안
```

**그런데 이 파일이 우리가 어차피 포크할 `nostr-relay-nestjs`다.** 106행 *앞*에 추출을 끼우면 끝:

```ts
async handleMessage(client: WebSocket, data: Array<any>) {
  const envelope = this.paymentGuard.take(data);   // data[2] 를 꺼내고 data 를 2원소로 자름
  const msg = await this.validator.validateIncomingMessage(data);
  ...
}
```

`PaymentGuardPlugin`이 `take()`로 봉투를 event.id 키로 물고 있다가 `beforeHandleEvent(event)`에서
꺼내 쓴다. **`@nostr-relay/*` npm 패키지는 하나도 포크 안 한다.** 전부 우리 포크 안에서 끝난다.

⚠️ 남는 한계: 이 방식은 우리 포크 전용이라 **스톡 스택에 그대로 못 꽂힌다**(요구사항 4의 "슥 붙이기").
업스트림 PR 후보 2건 — (a) EVENT tuple에 `.rest(z.unknown())`, (b) 검증 전 훅 노출.
둘 중 하나만 들어가면 플러그인 하나로 배포 가능해진다. **M2 이후 과제**.

### 5.2 인터페이스

```ts
// 결제 원장 — 영구 저장소
interface PaymentRepository {
  // 이중사용 방지. proof secret / payment hash 기준 UNIQUE.
  recordSpend(r: { eventId: string; method: string; ref: string; amount: number }): Promise<void>
  findByRef(ref: string): Promise<PaymentRecord | null>
}

// 레일 어댑터
interface Collector {
  readonly method: string
  validate(envelope: unknown, ctx: { eventId: string; price: number }): Promise<ValidationResult>  // 돈 안 건드림
  collect(envelope: unknown, ctx: { eventId: string; price: number }): Promise<CollectResult>       // swap / 정산확인
  refund(collected: CollectResult): Promise<string>                                                 // fresh proofs 반환용
}
```

`validate`(§3.4의 4단계)와 `collect`(5단계)를 **분리하는 게 핵심**이다. 순서 보장이 여기서 나온다.

---

## 6. 클라이언트 측 ← 구조 질문의 답

### 6.0 결론 먼저 — 라이브러리가 float을 갖는다 (2026-09-05 반전)

**"라이브러리가 돈을 안 만진다"와 "앱이 레일 무관 드랍인"은 동시에 못 가진다.** 후자를 택한다.
모든 nostr 클라에 Cashu 지갑 구현을 요구하면 채택이 시작도 안 된다.

결정적 사실 두 개:
- **NUT-04 민트 견적이 bolt11을 준다**([04.md:23-26](../nuts/04.md#L23-L26)). → NWC `pay_invoice`
  하나로 ecash를 살 수 있다. 환불은 NUT-05 melt → NWC `make_invoice`.
- **NWC 코어에 keysend가 없다**(§4.2). → 릴레이가 keysend를 원해도 NWC 클라는 직접 결제할 수 없다.

따라서 **ecash float이 레일 무관성을 얻는 유일한 경로**다. 라이브러리가 민트 연결·키·잔고를
전부 떠안고, 앱에는 NWC 2개 메서드만 요구한다.

#### 앱은 **URI가 아니라 능력(capability)을 준다**

⚠️ 2026-09-05 정정. 한때 `new PaidPool({ nwc: "nostr+walletconnect://…" })`로 적었는데 **틀렸다**:

1. **예산 스코프가 안 맞는다.** NIP-47 예산은 커넥션 단위이고 URI 펍키는 *"unique per client
   connection"*, 제약은 *"different keys for different **applications**… (eg. budgets)"*
   ([47.md:142](../nips/47.md#L142), [47.md:149](../nips/47.md#L149)). **서브예산이 없다** —
   URI를 넘기면 라이브러리가 **앱 전체 예산**을 상속한다. "NWC 한도가 안전을 잡아준다"는 옛 서술은
   무효. 그 한도는 앱의 한도지 페이월의 한도가 아니다.
2. **앱이 이미 NWC 클라다.** nostr-tools [nip47.ts](../nostr-tools/nip47.ts)는 46줄
   (`parseConnectionString` + `makeNwcRequestEvent`)뿐 — **클라 루프(릴레이 연결·23195 응답 대기·
   상관관계·타임아웃)가 없다.** URI를 받으면 그걸 재구현하고 지갑 릴레이에 **두 번째 소켓**을 연다.
3. **NWC만 있는 게 아니다.** WebLN·Alby 확장·내장 지갑·Tauri 네이티브 노드. URI는 하나로 못 박는다.

```ts
const pool = new PaidPool({
  funding: {                                                   // 앱이 주는 전부
    payInvoice:  (bolt11: string) => Promise<{ preimage: string }>,  // 충전
    makeInvoice: (sats: number)   => Promise<string>,                // 환불
  },
  limits: { maxFloatSats: 500, maxTopUpPerDaySats: 2000 },
})
```

앱 변경량: **~7줄**(한 줄 아님). 앱은 자기가 이미 쓰는 결제 함수를 물려주면 되므로 새로 배울
개념이 없다. `nwc:` 문자열은 **헤드리스 전용 편의**로만 남긴다(우리 CLI·데모처럼 호스트 앱이
없는 경우).

노출 API 2개: **충전**(`topUp(sats)`, 유료 릴레이 최초 조우 시 자동 호출) / **환불**(`refundAll()`).

#### 안전은 층으로 — **하드캡은 라이브러리가 줄 수 없다**

| 층 | 수단 | 강도 |
|---|---|---|
| 하드캡 | 유저가 지갑앱에서 **전용 NWC 커넥션** 발급 | 진짜 상한. **옵트인**, 권장 설정으로 문서화 |
| 중간 | 앱의 `payInvoice` 안에서 확인 UI — 앱이 이미 가진 결제확인 흐름 재사용 | 앱 정책. 라이브러리 비용 0 |
| 소프트 | 라이브러리 `limits`(float 상한·기간당 충전 상한) | 자체 회계. **암호학적 보증 아님** |

하드캡은 결제 능력을 넘겨준 쪽에서만 나온다. 라이브러리는 자기 한도를 성실히 지킬 뿐이고,
그걸 "안전이 보장된다"고 말하면 안 된다.

#### ⚠️ float을 갖는 대가 (정직하게)

| # | 대가 |
|---|---|
| C1 | **영구 저장이 선택이 아니라 필수.** ecash를 잃으면 돈을 잃는다. 브라우저 저장소 축출 대비 필요 |
| C2 | **멀티탭 = 이중지불 위험.** 두 탭이 같은 proof를 쓰면 하나는 실패한다. **단일 writer 락 필수** |
| C3 | **브라우저 저장소의 ecash는 베어러 → XSS면 도난.** float을 작게(≈500 sat) 유지 + 환불을 쉽게 + 경고 |

C2가 제일 실질적이다. `BroadcastChannel` + `navigator.locks`로 단일 writer를 강제할 것.

### 6.1 층 구조 — 자체 지갑이 있는 앱도 받는다

§6.0의 float은 **기본 구현**이고, 그 아래에 콜백 주입 층이 그대로 남는다. 자체 Cashu 지갑이 있는
앱은 float을 우회하고 `Payer`를 직접 꽂으면 된다. 같은 인터페이스의 기본값이라 층이 늘어난 게 아니다.

### 6.2 콜백 층: nostr-tools가 NIP-42로 이미 푼 문제다

서명키는 앱이 갖고 릴레이는 발행 도중 AUTH를 요구한다 — 구조가 동일하다. nostr-tools의 해법:

```ts
// abstract-pool.ts:21
automaticallyAuth?: (relayURL: string) => null | ((event: EventTemplate) => Promise<VerifiedEvent>)
// abstract-pool.ts:380 — 호출별 오버라이드
publish(relays, event, { onauth })
```

그대로 베낀다:

```ts
type Payer = (relayURL: string) => null | ((req: PaymentRequest) => Promise<PaymentEnvelope | null>)

interface PaymentRequest {
  relayUrl: string
  event: Event          // 서명 완료, id 확정
  terms: PaymentTerms   // NIP-11에서 파싱 (금액·단위·수단·민트·P2PK 펍키)
}
```

이 층에서 `client` 패키지가 하는 일은 넷뿐:
1. 어떤 릴레이가 유료인지 캐시
2. 술어를 로컬 평가 (1-shot 판정)
3. 결제가 필요하면 `Payer` 호출
4. 봉투를 EVENT 메시지에 끼워 넣고 OK 파싱

`null` 반환 = "이 릴레이엔 돈 안 낸다".

### 6.3 계층

```
 App                    자기가 이미 쓰는 결제 함수 · 확인 UI · 예산 정책
  │  funding: { payInvoice, makeInvoice }      ← URI 아님 (§6.0)
 @nostr-paywall/float   ecash 보유 · 민트 클라 · 영구저장 · 단일 writer 락
  │  Payer 구현으로 주입 (기본값)
 @nostr-paywall/client  PaidPool extends SimplePool
  │  patched send
 nostr-tools            무수정
```

`PaidPool extends SimplePool`로 `publish()`만 오버라이드 → 앱은 `new SimplePool()`을
`new PaidPool({ funding, limits })`로 바꾸면 된다(≈7줄).

자체 Cashu 지갑이 있는 앱은 `float` 층을 건너뛰고 `payer`를 직접 꽂는다(§6.1).

### 6.4 EVENT 메시지에 봉투 끼우기 (nostr-tools 무수정)

`publish()`는 두 가지를 한다 — [abstract-relay.ts:357](../nostr-tools/abstract-relay.ts#L357)에서
resolver를 `openEventPublishes`에 등록하고, [:360](../nostr-tools/abstract-relay.ts#L360)에서
`this.send(...)`로 보낸다. `openEventPublishes`는 private이라 직접 `send()`를 부르면 OK가
[:537](../nostr-tools/abstract-relay.ts#L537)의 `if (ep)`에서 조용히 버려진다.

**해법: public인 `send`를 인스턴스에 덮어씌우고 `publish()`를 그대로 쓴다.**

```ts
const relay = await pool.ensureRelay(url)     // public — abstract-pool.ts:73
const orig = relay.send.bind(relay)
relay.send = async (msg: string) => {
  relay.send = orig                            // one-shot 복구
  return orig(msg.slice(0, -1) + ',' + JSON.stringify(envelope) + ']')
}
await relay.publish(event)                     // resolver 등록은 publish가 해줌 → OK 정상 수신
```

private 접근 0, 포크 0, `as any` 0. 동시 발행 레이스는 event.id 키 맵으로 처리.

### 6.5 발행 흐름

```
publish(relays, event):
  for each relay:
    cache = policy.get(relay)

    ├ unknown → 2원소로 그냥 발행
    │            ├ OK true          → free로 캐시. 끝
    │            └ payment-required → NIP-11 fetch → terms 캐시
    │                                 → payer(relay)(req) → 봉투 붙여 재발행 (재시도 1회 캡)
    │
    ├ free → 2원소 발행
    │
    └ paid → 술어 로컬 평가
               ├ 무과금 → 2원소 발행
               └ 과금   → payer(relay)(req) → 3원소 1-shot 발행
```

- 캐시는 릴레이 URL → `{ status, terms, learnedAt }`. 앱이 `Storage`를 주입하면 영속화(새로고침 후
  재학습 불필요). 선택 사항.
- ⚠️ 1-shot 경로도 `payer`가 민트를 호출하므로 발행 지연에 민트 왕복이 포함된다.
- ⚠️ 학습 경로에선 **거부되기 전에 이벤트 본문이 이미 릴레이에 전달된다**. DM엔 프라이버시 함의가
  있으니 DM은 terms를 먼저 확보한 뒤 발행할 것.

---

### 6.6 무해한 드랍인을 위한 3가지

드랍인이 되는 건 확인됐다(§6.0). 문제는 **드랍인이 조용히 해를 끼치지 않게** 하는 것이다.

**(a) 지불 불가 = 발행 실패다. 조용하면 안 된다.**
`pool.publish()`는 릴레이별 promise 배열이고 대부분의 클라는 "하나라도 성공"을 성공으로 친다.
그런데 우리 설계상 유료 릴레이는 하필 **답글 상대의 inbox 릴레이**다 → 답글이 상대에게 전달 안 됐는데
UI는 성공으로 뜬다. nostr가 고장난 것처럼 느껴지는 바로 그 실패 모드.
→ 라이브러리는 `PaymentUnavailableError`(지불수단 없음 / 한도 초과 / 유저 거부)를 **일반 네트워크
오류와 구별되게** reject해야 한다. 클라가 *"이 답글은 상대 릴레이에 전달되지 않았습니다"*를
띄울 수 있어야 한다. **라이브러리 책임.**

**(b) `autoTopUp` 기본값은 `false`.**
안 그러면 유저가 처음 유료 릴레이에 답글 다는 순간 말 없이 500 sat이 나간다. 앱의 `payInvoice`가
확인 UI를 띄워줄 수도 있지만 안 띄우는 지갑도 많고 거기 의존하면 안 된다. **라이브러리 init만으로
유저 돈이 나가면 그 라이브러리는 손절당한다.** → 개발자가 켜거나 `onTopUpRequired` 콜백으로 앱이
물어보게. 드랍인은 배선까지고 **첫 지출은 명시적 동의**를 거친다.

**(c) funding 가용성은 미리 알아야 한다.**
콜백 등록만으로는 유저가 NWC를 연결했는지 알 수 없다 — 첫 결제 시도 때 throw나야 안다.
→ `funding`을 nullable로 두거나 `isAvailable()`를 옵션으로 받고, "지불 불가"를 캐시해서
발행마다 헛된 왕복을 반복하지 않는다.

### 6.7 드랍인의 사정거리 (정확히)

nostr-tools를 **직접** 쓰는 클라에겐 진짜 드랍인이다. 다만 생태계 상당수가 **NDK**를 쓰고 NDK는
`SimplePool`이 아니라 자체 풀을 갖는다(applesauce 등도). 걔들은 얇은 어댑터가 필요하다.
치명적이진 않다 — 진짜 자산은 프로토콜이고 어댑터는 얇다. 다만 **"모든 nostr 클라에 드랍인"이라고
말하지 말 것.** 정확한 문장은 *"nostr-tools 직접 사용자에겐 드랍인, NDK 계열은 어댑터"*.
→ M3 때 `reference/`에 NDK 클론해서 실제 확장 지점 확인(V10).

## 7. 패키지

```
nostr-paywall/                      (레포 1개, pnpm workspace)
├─ packages/protocol/      술어 · 봉투/terms 타입 · OK 파서 · NIP-11 파서.  순수, I/O 0
├─ packages/relay-guard/   PaymentGuardPlugin · PaymentRepository · Collector
├─ packages/collectors/    cashu / ln-keysend 어댑터
├─ packages/client/        PaidPool · 정책 캐시 · Payer 타입
├─ packages/float/         ecash float — 민트 클라 · 영구저장 · 단일 writer 락 · NWC 충전/환불
└─ apps/demo/             데모 웹클라
```

릴레이 본체는 새 레포가 아니라 `nostr-relay-nestjs` 포크 — boltz/arkd에 쓰는 fork-branch 모델 그대로.
`protocol`을 릴레이와 클라가 공유하는 게 핵심(술어가 두 벌이면 반드시 갈린다).

---

## 8. 마일스톤

| M | 내용 | 완료 기준 |
|---|---|---|
| ✅ M0 | 이 문서 | 스키마 2개(§3.2·§3.5) 확정 |
| ✅ M1 | `protocol` | **59/59 green** (2026-09-05). 술어·NIP-11 파서·봉투·EVENT 메시지·OK 왕복 |
| 🔨 M2 | 릴레이 포크 + guard + sqlite repo + cashu collector | **순수 로직 완료**(유닛 111 + 라이브 스모크). 남은 것: 릴레이 포크 배선뿐 |
| M3 | `client` PaidPool + `float`(NWC 충전 → 1sat 지출 → 환불) | CLI로 유료 발행 1건 + 잔액 환불 1건 |
| M4 | 데모 웹 | 하드코딩 npub 5글 + 재귀 아웃박스 덧글 트리 |
| M5 | ln-keysend collector | 직접 채널 시연 1건 |

### M1 결과 (2026-09-05)

`packages/protocol` — 런타임 의존성 0. 릴레이(node)와 클라(브라우저)가 **같은 코드**를 쓴다.

| 파일 | 역할 |
|---|---|
| `types.ts` | terms·봉투 타입. nostr-tools를 import 하지 않아 릴레이가 클라 의존성을 안 끌고 온다 |
| `terms.ts` | NIP-11 → `PaymentTerms`. 신뢰 불가 원격 JSON이라 **절대 throw 안 함**, 못 읽으면 무료 취급 |
| `predicate.ts` | `priceFor()` + v1 기본 정책 상수. **정책은 코드가 아니라 terms에 있다** — 클라는 *릴레이의* 정책을 평가한다 |
| `envelope.ts` | 봉투 모양 검증 + `isMintAllowed`(H1). 암호 검증은 여기 없음(collector 소관) |
| `message.ts` | `encodeEventMessage` / `spliceEnvelope`(nostr-tools 문자열용) / `takePaymentEnvelope`(릴레이 진입점) |
| `ok.ts` | OK 접두사 상수 + 조립(릴레이) + 해석(클라). **한 파일에 둬서 문자열이 두 벌로 갈리는 걸 막는다** |

설계 논쟁이 걸린 케이스는 전부 테스트로 못박았다 — q 단독 무료, kind 3의 p 태그 300개 무료,
NIP-22 웹URL 코멘트 무료 vs 이벤트 코멘트 과금, 대문자 `E`/`P` 무료, allowlist 밖 kind 무료,
`spliceEnvelope`가 `encodeEventMessage`와 바이트 동일, 환불이 접두사보다 우선.

작성 중 실제 버그 1건을 테스트가 잡았다: 환불 응답의 사람용 `message`에 기계용 토큰이 딸려 들어갔다.

### M2 진행 (2026-09-05) — collector 완료

`packages/collectors` — 유닛 25 green + `scripts/smoke-cashu.ts` 라이브 왕복 통과.

- `mint-policy.ts` — **부팅 게이트**. allowlist 민트의 활성 sat 키셋 `input_fee_ppk` 를 읽어
  0이 아니면 **던져서 릴레이를 못 띄운다**(D13). 이게 없으면 유저 돈만 받고 수납은 실패하는
  상태로 조용히 굴러간다.
- `cashu.ts` — `validate`(돈 안 건드림) / `collect`(swap) 분리. §3.4 순서가 여기서 강제된다.

구현하며 나온 것 2건:

1. **봉투의 `mint` 필드만 믿으면 뚫린다.** allowlist 민트를 자칭하면서 다른 민트 토큰을 실을 수
   있으므로 **디코드한 토큰 안의 `mint`** 로 판정한다.
2. **`getEncodedToken` 은 keyset id 형식을 검증하고 던진다.** 환불 토큰을 만들다 터지면
   *이미 돈을 받은 뒤*라 §3.4-7 환불 경로가 통째로 죽는다 → 삼키고 `refundToken: null`.
   대신 `CollectResult.proofs` 로 원물을 항상 넘긴다.
   **릴레이는 이 proofs 를 반드시 영구 저장해야 한다** — 베어러라 재시작 한 번에 전부 잃는다.

### M2 진행 (2026-09-05) — 결제 원장 완료

`packages/relay-guard` — 유닛 15 green. **`node:sqlite` 라 네이티브 의존성 0**(Node 22.5+ 내장).

원장이 지키는 것 셋:
1. **이중사용** — `payment_ref.ref` PRIMARY KEY 가 곧 "이 proof secret 은 한 이벤트만 산다"
2. **멱등(유저 보호)** — `already-paid` / `in-progress` / `conflict` 상태 머신.
   **클라가 봉투를 잃고 새 proofs 로 재시도해도 `event_id` 로 잡혀 재과금되지 않는다**
3. **자산 보관** — 수납 proofs 는 베어러다. 이 원장이 **유일한 사본**이라 감사 로그가 아니라
   자산 원장이다. 릴레이 이벤트 저장소(Postgres)와 독립시킨 이유도 이것 — 한쪽이 날아가도 다른 쪽은 산다

설계 메모: DB 검사는 **빠른 길일 뿐 최종 심판이 아니다.** 동시 요청 둘이 다 통과해도 민트의
swap 이 한쪽을 죽인다. 원장은 낭비를 줄이고 멱등을 정확히 하기 위한 것.

⚠️ 도구 함정: **`node:sqlite` 는 prefix-only 빌트인**이다(`builtinModules` 에 `'sqlite'` 없이
`'node:sqlite'` 로만 있음). Vite 가 `node:` 를 떼고 조회해 `Failed to load url sqlite` 로 죽는다.
vitest 5 에서 해결됨 — 그보다 낮은 버전은 이 패키지를 못 돌린다.

### M2 진행 (2026-09-05) — guard 조립 완료, 순수 로직 끝

`PaymentGuard` 는 **훅 비의존**이다 — `@nostr-relay/*` 를 import 하지 않아 어느 릴레이 구현에도
얹히고 유닛 테스트도 릴레이 없이 돈다. 특정 훅에 맞추는 건 얇은 어댑터 몫.

§3.4 의 "순서가 곧 안전장치"를 **호출 추적으로 못박았다**:
- validate 가 거부하면 `collect` 가 **안 불린다**
- 이중사용(conflict)이면 `collect` 가 **안 불린다**
- 이미 낸 이벤트를 다시 보내면 `collect` 가 **안 불린다**(재과금 0)

돈은 받았는데 실패하는 두 경로도 코드로 닫았다:
- **원장 기록 실패** → 성공이라 우기지 않고 손에 있는 환불 토큰을 즉시 돌려준다
- **환불 토큰조차 못 만듦** → 정직하게 알린다. 삼키면 유저는 영문도 모르고 잃는다
- **저장 실패**(`onStorageFailed`) → 환불 토큰 + 원장 failed. 이 경로가 없으면 §3.4-7 이 말뿐이 된다

`rate-limited` 접두사 추가: 같은 이벤트 결제가 처리 중일 때 `payment-invalid` 를 쓰면
"이 봉투로 재시도하지 마라"는 **잘못된 신호**가 된다. 봉투엔 문제가 없고 잠시 후 재시도가 맞다.

### 데모(M4) 설계

하드코딩 npub의 최근 글 5개를 그 npub의 **write 릴레이**에서 가져오고, 각 글의 덧글은 그 저자의
**read(inbox) 릴레이**에서만 가져온다([NIP-65](../nips/65.md#L29-L31)). 대상 npub의 inbox를 이 유료
릴레이 하나로만 세팅 → **depth 1에 달린 덧글은 전부 돈 낸 것**. 덧글의 덧글은 그 작성자의 inbox(무료)로
가므로 스팸이 섞인다. 그 대비를 화면에서 그대로 보여주는 게 데모의 전부다.

**주장 정확히**: "depth 1엔 스팸이 없다"가 아니라 **"depth 1 스팸은 건당 1 sat이다"**.
그리고 이 데모의 진짜 요점은 생태계 협조가 아니라 **읽는 사람의 클라만 바꾸면 된다**는 것 —
저자의 inbox 릴레이에서만 답글을 읽는 건 순전히 독자 본인 이익이고 누구의 협조도 필요 없다.

DM은 데모 범위 밖(그래서 NIP-42 AUTH도 범위 밖).

---

## 9. 미해결 / 검증 필요

| # | 항목 | 왜 |
|---|---|---|
| ~~V1~~ | ~~NUT-11 P2PK 원문 확인~~ | ✅ 전제는 참이나 **v1에서 P2PK 자체를 기각**(D5). 검증 6건도 같이 소멸. 근거·체크리스트는 §4.1 v2 블록에 보존 |
| ~~V7~~ | ~~민트 선정~~ | ✅ **완료**. 개발=`testnut.cashu.space`(가짜 인보이스 자동결제, 단 ppk=100이라 ≥2 sat만), mainnet 후보=`minibits`/`21mint`(둘 다 ppk=0). §4.1 H1b 표 |
| V11 | **1 sat 실경로 검증** — ppk=0 민트(minibits)에서 mint→봉투→수납 왕복 | ppk=0 공개 *테스트* 민트가 없어(`nofees.testnut` 다운) 실사토시 소액 필요. 운영머신 LN에서 충전 |
| V9 | float 단일 writer 락 — `navigator.locks`/`BroadcastChannel`로 멀티탭 이중지불 차단 | §6 C2. **실질 위험 1순위** |
| V10 | NDK의 발행 확장 지점 — `SimplePool` 아닌 자체 풀이라 어댑터 필요 | §6.7. 생태계 사정거리를 결정. M3 때 클론해서 확인 |
| ~~V8~~ | ~~`cashu-ts`의 P2PK/DLEQ 지원~~ | ✅ **전부 있음**. 아래 API 매핑 |
| ~~V2~~ | ~~`@nostr-relay/validator`가 3원소 EVENT를 거부하는가~~ | ✅ **거부함**. 해결은 §3.1·§5.1 (포크 안에서 검증 전 추출) |
| ~~V3~~ | ~~`BeforeHandleEventPlugin`에 봉투를 전달할 경로~~ | ✅ **해결**. §5.1 — `@nostr-relay/*` 포크 불필요 |
| ~~V4~~ | ~~Cashu 민트 swap 실지연~~ | ✅ **실측**: swap(receive) ~460ms, mint quote ~440ms, loadMint 300ms~1s(캐시 가능). 이벤트당 예산은 swap 1회 ≈ 0.5s |
| ~~V5~~ | ~~keysend 정산 지연 → 릴레이 대기 창~~ | ✅ **소멸**. 클라가 정산 확인 후 EVENT 전송(§4.2) |
| V6 | 대상 npub의 kind 10002를 유료 릴레이만으로 세팅했을 때 부작용 | 데모 npub은 실계정 말고 전용 키 쓸 것 |

## 10. 명시적 비목표 (v1)

- 읽기 과금 · NIP-42 AUTH · REST/HTTP 경로 (NIP-98)
- kind별 차등 가격 · **수신자별 가격** (v2의 핵심 아이디어 — 수수료는 주의력에 대한 피구세이고
  주의력의 주인은 태그당하는 사람이다. 구조만 확장 가능하게 두고 v1은 일괄가)
- 릴레이 자체 민트 · Ark 레일
- **P2PK-lock + DLEQ 배치 정산** — 지연이 실제 문제가 될 때 §4.1 v2 블록에서 통째로 가져온다.
  "P2PK 없이 배치"는 불가(이중지불) — 반드시 검증 체크리스트와 **세트로** 채택할 것
- NestJS 데코레이터 API (§5.1의 봉투 전달이 풀린 뒤)

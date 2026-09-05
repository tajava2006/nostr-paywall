// 결제 원장 계약.
//
// 이 원장이 지키는 것 세 가지:
//   1. **이중사용 방어** — 같은 proof secret 이 두 이벤트를 사지 못한다
//   2. **멱등** — 같은 이벤트를 두 번 보내도 두 번 과금되지 않는다 (§3.6, 유저 보호 방향)
//   3. **자산 보관** — 수납한 proofs 는 베어러다. 여기 없으면 재시작 한 번에 전부 잃는다
//
// 3번이 감사 로그가 아니라 **자산 원장**인 이유다. 릴레이가 걷은 ecash 의 유일한 사본이다.

export type PaymentState = 'pending' | 'collected' | 'failed';

export interface PaymentRecord {
  eventId: string;
  method: string;
  state: PaymentState;
  amountMsat: number;
  /** `collected` 일 때만. 릴레이가 소유한 실제 자산. */
  proofs: unknown[] | null;
  /** `failed` 일 때만. */
  reason: string | null;
  createdAt: number;
  updatedAt: number;
}

export type ReserveResult =
  /** 진행해도 된다. collect 를 부르고 commit/fail 로 닫을 것. */
  | { kind: 'reserved' }
  /**
   * 같은 이벤트가 **이미 수납 완료**. 다시 받지 말고 저장만 하면 된다.
   * 클라가 봉투를 잃고 새 봉투로 재시도한 경우까지 여기서 잡힌다 — 유저 보호의 핵심.
   */
  | { kind: 'already-paid'; record: PaymentRecord }
  /** 같은 이벤트가 동시에 처리 중. 중복 요청이므로 그냥 거절한다. */
  | { kind: 'in-progress' }
  /** 같은 refs 가 **다른 이벤트**에 이미 쓰였다 = 이중사용 시도. */
  | { kind: 'conflict'; otherEventId: string };

export interface PaymentRepository {
  /**
   * refs 를 원자적으로 선점한다. 상태 전이는 `ReserveResult` 참조.
   *
   * 이 검사는 **빠른 길일 뿐 최종 심판이 아니다** — 진짜 이중사용 방어는 민트의 swap 이다.
   * 동시에 들어온 두 요청이 둘 다 통과해도 민트에서 한쪽이 죽는다. 원장은 낭비를 줄이고
   * 멱등을 정확히 하기 위한 것.
   */
  reserve(eventId: string, method: string, refs: readonly string[]): Promise<ReserveResult>;

  /** 수납 성공. **proofs 를 반드시 영구 저장한다.** */
  commit(
    eventId: string,
    amountMsat: number,
    proofs: readonly unknown[],
  ): Promise<void>;

  /** 수납 실패. 같은 봉투로 재시도할 수 있게 남긴다(지우지 않는다). */
  fail(eventId: string, reason: string): Promise<void>;

  /** 조회. */
  find(eventId: string): Promise<PaymentRecord | null>;

  /**
   * 릴레이가 보유한 수납 proofs 전부. 잔고 확인·정산·이관용.
   * 이게 비면 걷은 돈이 없거나 **원장을 잃은 것**이다.
   */
  listCollected(limit?: number): Promise<PaymentRecord[]>;
}

// The payment ledger contract.
//
// It guarantees three things:
//   1. **No double spend** — one proof secret cannot buy two events
//   2. **Idempotency** — sending the same event twice never charges twice (PLAN §3.6,
//      deliberately biased towards protecting the user)
//   3. **Custody** — collected proofs are bearer money; without this record one restart
//      loses all of it
//
// (3) is why this is an asset ledger rather than an audit log: it is the only copy of the
// ecash the relay has collected.

export type PaymentState = 'pending' | 'collected' | 'failed';

export interface PaymentRecord {
  eventId: string;
  method: string;
  state: PaymentState;
  amountMsat: number;
  /** Only when `collected`. The relay's actual assets. */
  proofs: unknown[] | null;
  /** Only when `failed`. */
  reason: string | null;
  createdAt: number;
  updatedAt: number;
}

export type ReserveResult =
  /** Proceed: call collect, then close with commit or fail. */
  | { kind: 'reserved' }
  /**
   * This event was **already collected**. Store it, charge nothing.
   * Also covers the client losing its envelope and retrying with fresh proofs —
   * the heart of protecting the user.
   */
  | { kind: 'already-paid'; record: PaymentRecord }
  /** The same event is in flight. A duplicate request; reject it. */
  | { kind: 'in-progress' }
  /** These refs already bought a **different** event: a double-spend attempt. */
  | { kind: 'conflict'; otherEventId: string };

export interface PaymentRepository {
  /**
   * Atomically reserve these refs. See `ReserveResult` for the transitions.
   *
   * This check is a **fast path, not the final arbiter** — the mint's swap is. Two concurrent
   * requests may both pass here and one dies at the mint. The ledger exists to avoid wasted
   * work and to get idempotency exactly right.
   */
  reserve(eventId: string, method: string, refs: readonly string[]): Promise<ReserveResult>;

  /** Collection succeeded. **Persist the proofs.** */
  commit(
    eventId: string,
    amountMsat: number,
    proofs: readonly unknown[],
  ): Promise<void>;

  /** Collection failed. Keep the row so the same envelope can be retried. */
  fail(eventId: string, reason: string): Promise<void>;

  /** Lookup. */
  find(eventId: string): Promise<PaymentRecord | null>;

  /**
   * Every collected proof the relay holds — for balance checks, settlement, migration.
   * An empty result means either nothing was collected or **the ledger was lost**.
   */
  listCollected(limit?: number): Promise<PaymentRecord[]>;
}

// `node:sqlite` 구현 — **네이티브 의존성 0**(Node 22.5+ 내장).
//
// 릴레이 본체는 Postgres 를 쓰지만, 원장은 그것과 독립이다. 이벤트 저장소가 날아가도
// 걷은 ecash 는 살아야 하고, 반대도 마찬가지다. 단일 파일이라 백업도 `cp` 한 번이다.

import { DatabaseSync } from 'node:sqlite';
import type {
  PaymentRecord,
  PaymentRepository,
  PaymentState,
  ReserveResult,
} from './repository.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS payment (
  event_id    TEXT PRIMARY KEY,
  method      TEXT NOT NULL,
  state       TEXT NOT NULL,
  amount_msat INTEGER NOT NULL DEFAULT 0,
  proofs      TEXT,
  reason      TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
) STRICT;

-- 이중사용 방어의 실체. ref = Cashu proof secret.
-- PRIMARY KEY 가 곧 "이 secret 은 한 이벤트만 살 수 있다"는 제약이다.
CREATE TABLE IF NOT EXISTS payment_ref (
  ref      TEXT PRIMARY KEY,
  event_id TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS payment_ref_event ON payment_ref(event_id);
CREATE INDEX IF NOT EXISTS payment_state ON payment(state);
`;

interface Row {
  event_id: string;
  method: string;
  state: string;
  amount_msat: number;
  proofs: string | null;
  reason: string | null;
  created_at: number;
  updated_at: number;
}

function toRecord(r: Row): PaymentRecord {
  return {
    eventId: r.event_id,
    method: r.method,
    state: r.state as PaymentState,
    amountMsat: r.amount_msat,
    proofs: r.proofs === null ? null : (JSON.parse(r.proofs) as unknown[]),
    reason: r.reason,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export class SqlitePaymentRepository implements PaymentRepository {
  private readonly db: DatabaseSync;

  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path);
    // WAL: 릴레이는 읽기(중복확인)와 쓰기(수납)가 섞인다. 파일 DB 에서만 의미 있다.
    if (path !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  async reserve(
    eventId: string,
    method: string,
    refs: readonly string[],
  ): Promise<ReserveResult> {
    if (refs.length === 0) throw new Error('refs 가 비어 있다 — 선점할 대상이 없다');
    const now = Date.now();

    this.db.exec('BEGIN IMMEDIATE');
    try {
      // 1) 다른 이벤트가 이 refs 를 이미 썼는가 = 이중사용
      const placeholders = refs.map(() => '?').join(',');
      const clash = this.db
        .prepare(`SELECT event_id FROM payment_ref WHERE ref IN (${placeholders})`)
        .all(...refs) as unknown as { event_id: string }[];
      const other = clash.find((c) => c.event_id !== eventId);
      if (other) {
        this.db.exec('ROLLBACK');
        return { kind: 'conflict', otherEventId: other.event_id };
      }

      // 2) 같은 이벤트의 기존 상태
      const existing = this.db
        .prepare('SELECT * FROM payment WHERE event_id = ?')
        .get(eventId) as unknown as Row | undefined;

      if (existing) {
        if (existing.state === 'collected') {
          this.db.exec('ROLLBACK');
          return { kind: 'already-paid', record: toRecord(existing) };
        }
        if (existing.state === 'pending') {
          this.db.exec('ROLLBACK');
          return { kind: 'in-progress' };
        }
        // failed → 재시도 허용. 상태만 되돌린다.
        this.db
          .prepare("UPDATE payment SET state='pending', reason=NULL, updated_at=? WHERE event_id=?")
          .run(now, eventId);
      } else {
        this.db
          .prepare(
            `INSERT INTO payment (event_id, method, state, created_at, updated_at)
             VALUES (?, ?, 'pending', ?, ?)`,
          )
          .run(eventId, method, now, now);
      }

      // 3) refs 선점. 이미 우리 것이면 그대로 둔다(재시도 경로).
      const ins = this.db.prepare(
        'INSERT INTO payment_ref (ref, event_id) VALUES (?, ?) ON CONFLICT(ref) DO NOTHING',
      );
      for (const ref of refs) ins.run(ref, eventId);

      this.db.exec('COMMIT');
      return { kind: 'reserved' };
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  async commit(
    eventId: string,
    amountMsat: number,
    proofs: readonly unknown[],
  ): Promise<void> {
    const n = this.db
      .prepare(
        `UPDATE payment SET state='collected', amount_msat=?, proofs=?, reason=NULL, updated_at=?
         WHERE event_id=? AND state='pending'`,
      )
      .run(amountMsat, JSON.stringify(proofs), Date.now(), eventId);
    // pending 이 아닌데 commit 이 오면 상태 머신이 깨진 것이다. 조용히 넘기면
    // 자산(proofs)이 기록되지 않은 채 성공으로 보고된다.
    if (n.changes === 0) {
      throw new Error(`commit 대상이 pending 이 아니다: ${eventId}`);
    }
  }

  async fail(eventId: string, reason: string): Promise<void> {
    this.db
      .prepare("UPDATE payment SET state='failed', reason=?, updated_at=? WHERE event_id=?")
      .run(reason, Date.now(), eventId);
  }

  async find(eventId: string): Promise<PaymentRecord | null> {
    const row = this.db.prepare('SELECT * FROM payment WHERE event_id = ?').get(eventId) as
      | Row
      | undefined;
    return row ? toRecord(row) : null;
  }

  async listCollected(limit = 1000): Promise<PaymentRecord[]> {
    const rows = this.db
      .prepare("SELECT * FROM payment WHERE state='collected' ORDER BY updated_at DESC LIMIT ?")
      .all(limit) as unknown as Row[];
    return rows.map(toRecord);
  }

  /** 걷은 총액(msat). 원장이 자산 원장이라는 걸 드러내는 편의 조회. */
  totalCollectedMsat(): number {
    const r = this.db
      .prepare("SELECT COALESCE(SUM(amount_msat), 0) AS total FROM payment WHERE state='collected'")
      .get() as unknown as { total: number };
    return r.total;
  }
}

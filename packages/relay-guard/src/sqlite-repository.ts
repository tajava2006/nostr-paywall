// A `node:sqlite` implementation — **no native dependencies** (built in since Node 22.5).
//
// The relay itself runs Postgres, but this ledger is independent of it: the event store can
// be lost without losing the collected ecash, and vice versa. One file, so backup is `cp`.

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

-- Where double-spend protection actually lives. ref = a Cashu proof secret; the primary
-- key *is* the constraint "this secret buys exactly one event".
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
    // WAL: reads (dedupe) and writes (collection) interleave. Only meaningful for a file DB.
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
    if (refs.length === 0) throw new Error('no refs to reserve');
    const now = Date.now();

    this.db.exec('BEGIN IMMEDIATE');
    try {
      // 1) Did another event already claim these refs? That is a double spend.
      const placeholders = refs.map(() => '?').join(',');
      const clash = this.db
        .prepare(`SELECT event_id FROM payment_ref WHERE ref IN (${placeholders})`)
        .all(...refs) as unknown as { event_id: string }[];
      const other = clash.find((c) => c.event_id !== eventId);
      if (other) {
        this.db.exec('ROLLBACK');
        return { kind: 'conflict', otherEventId: other.event_id };
      }

      // 2) Existing state for this event
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
        // failed → allow a retry; just reset the state.
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

      // 3) Claim the refs. Already ours means a retry, so leave them.
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
    // A commit against a non-pending row means the state machine is broken. Passing silently
    // would report success while the assets (proofs) go unrecorded.
    if (n.changes === 0) {
      throw new Error(`commit target is not pending: ${eventId}`);
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

  /** Total collected, in msat. A convenience that makes the asset-ledger nature obvious. */
  totalCollectedMsat(): number {
    const r = this.db
      .prepare("SELECT COALESCE(SUM(amount_msat), 0) AS total FROM payment WHERE state='collected'")
      .get() as unknown as { total: number };
    return r.total;
  }
}

// 결제 원장 — 이중사용·멱등·자산보관 세 가지를 못박는다.
// 여기가 깨지면 유저가 두 번 내거나, 릴레이가 걷은 돈을 잃거나, 공짜 발행이 뚫린다.

import { afterEach, describe, expect, it } from 'vitest';
import { SqlitePaymentRepository } from '../src/sqlite-repository.js';

let repo: SqlitePaymentRepository | undefined;
const make = () => (repo = new SqlitePaymentRepository(':memory:'));
afterEach(() => {
  repo?.close();
  repo = undefined; // 안 비우면 다음 테스트의 afterEach 가 닫힌 DB 를 또 닫는다
});

const E1 = 'a'.repeat(64);
const E2 = 'b'.repeat(64);
const PROOFS = [{ id: 'k', amount: 1, secret: 's1', C: '02' }];

describe('이중사용 방어', () => {
  it('같은 ref 로 다른 이벤트를 사려 하면 conflict', async () => {
    const r = make();
    expect(await r.reserve(E1, 'cashu', ['s1'])).toEqual({ kind: 'reserved' });
    await r.commit(E1, 1000, PROOFS);

    expect(await r.reserve(E2, 'cashu', ['s1'])).toEqual({
      kind: 'conflict',
      otherEventId: E1,
    });
  });

  it('아직 pending 인 ref 도 다른 이벤트엔 못 쓴다', async () => {
    const r = make();
    await r.reserve(E1, 'cashu', ['s1']);
    expect((await r.reserve(E2, 'cashu', ['s1'])).kind).toBe('conflict');
  });

  it('refs 중 하나만 겹쳐도 conflict', async () => {
    const r = make();
    await r.reserve(E1, 'cashu', ['s1', 's2']);
    expect((await r.reserve(E2, 'cashu', ['s3', 's2'])).kind).toBe('conflict');
  });

  it('겹치지 않으면 서로 독립', async () => {
    const r = make();
    await r.reserve(E1, 'cashu', ['s1']);
    expect((await r.reserve(E2, 'cashu', ['s2'])).kind).toBe('reserved');
  });
});

describe('멱등 — 유저를 보호하는 방향', () => {
  it('이미 수납된 이벤트를 다시 보내면 already-paid — 재과금 없음', async () => {
    const r = make();
    await r.reserve(E1, 'cashu', ['s1']);
    await r.commit(E1, 1000, PROOFS);

    const again = await r.reserve(E1, 'cashu', ['s1']);
    expect(again.kind).toBe('already-paid');
    if (again.kind === 'already-paid') expect(again.record.amountMsat).toBe(1000);
  });

  it('봉투를 잃고 **새 proofs** 로 재시도해도 재과금되지 않는다', async () => {
    // 클라가 봉투를 못 들고 있는 최악의 경우까지 event_id 로 잡힌다.
    const r = make();
    await r.reserve(E1, 'cashu', ['s1']);
    await r.commit(E1, 1000, PROOFS);

    const again = await r.reserve(E1, 'cashu', ['완전히-다른-secret']);
    expect(again.kind).toBe('already-paid');
  });

  it('처리 중 같은 이벤트가 또 오면 in-progress', async () => {
    const r = make();
    await r.reserve(E1, 'cashu', ['s1']);
    expect((await r.reserve(E1, 'cashu', ['s1'])).kind).toBe('in-progress');
  });

  it('실패한 결제는 같은 봉투로 재시도할 수 있다', async () => {
    const r = make();
    await r.reserve(E1, 'cashu', ['s1']);
    await r.fail(E1, 'mint timeout');
    expect((await r.find(E1))?.state).toBe('failed');

    expect((await r.reserve(E1, 'cashu', ['s1'])).kind).toBe('reserved');
    await r.commit(E1, 1000, PROOFS);
    expect((await r.find(E1))?.state).toBe('collected');
  });

  it('실패 기록을 지우지 않는다 — 지우면 무슨 일이 있었는지 사라진다', async () => {
    const r = make();
    await r.reserve(E1, 'cashu', ['s1']);
    await r.fail(E1, 'mint timeout');
    expect((await r.find(E1))?.reason).toBe('mint timeout');
  });
});

describe('자산 보관 — proofs 는 베어러다', () => {
  it('commit 이 proofs 를 원물 그대로 보존한다', async () => {
    const r = make();
    await r.reserve(E1, 'cashu', ['s1']);
    await r.commit(E1, 1000, PROOFS);
    expect((await r.find(E1))?.proofs).toEqual(PROOFS);
  });

  it('파일 DB 는 재시작을 넘어 살아남는다 — 여기가 유일한 사본이다', async () => {
    const path = `/tmp/paywall-test-${Date.now()}.db`;
    const a = new SqlitePaymentRepository(path);
    await a.reserve(E1, 'cashu', ['s1']);
    await a.commit(E1, 1000, PROOFS);
    a.close();

    const b = new SqlitePaymentRepository(path);
    expect((await b.find(E1))?.proofs).toEqual(PROOFS);
    expect(b.totalCollectedMsat()).toBe(1000);
    b.close();
  });

  it('listCollected 로 보유 자산을 훑을 수 있다', async () => {
    const r = make();
    await r.reserve(E1, 'cashu', ['s1']);
    await r.commit(E1, 1000, PROOFS);
    await r.reserve(E2, 'cashu', ['s2']);
    await r.fail(E2, 'nope');

    const all = await r.listCollected();
    expect(all).toHaveLength(1);
    expect(all[0]!.eventId).toBe(E1);
    expect(r.totalCollectedMsat()).toBe(1000);
  });
});

describe('상태 머신 방어', () => {
  it('pending 이 아닌 걸 commit 하면 던진다 — 조용히 넘기면 자산이 기록 없이 사라진다', async () => {
    const r = make();
    await expect(r.commit(E1, 1000, PROOFS)).rejects.toThrow(/not pending/);

    await r.reserve(E1, 'cashu', ['s1']);
    await r.commit(E1, 1000, PROOFS);
    await expect(r.commit(E1, 1000, PROOFS)).rejects.toThrow(/not pending/);
  });

  it('빈 refs 는 던진다 — 선점할 대상이 없는데 성공하면 이중사용이 뚫린다', async () => {
    const r = make();
    await expect(r.reserve(E1, 'cashu', [])).rejects.toThrow(/no refs to reserve/);
  });

  it('conflict 는 아무것도 남기지 않는다 (롤백)', async () => {
    const r = make();
    await r.reserve(E1, 'cashu', ['s1']);
    await r.reserve(E2, 'cashu', ['s1']);
    expect(await r.find(E2)).toBeNull();
  });
});

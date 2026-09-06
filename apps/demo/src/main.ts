// 데모 웹클라 — 평범한 nostr 클라처럼 생겼고, 딱 한 줄만 다르다:
//   new SimplePool()  →  new PaidPool({ payer })
// 나머지(구독·조회)는 손대지 않았다. 읽기는 무료니까.

import './style.css';
import type { Event } from 'nostr-tools/core';
import { PaymentUnavailableError } from '@nostr-paywall/client';
import {
  DEMO_RELAY,
  announceRelayListOnce,
  getNwc,
  myPubkey,
  setNwc,
  sign,
} from './identity.js';
import {
  BOOTSTRAP_RELAYS,
  fetchReactionsFor,
  fetchThread,
  publishTargetsFor,
  relayListFor,
} from './outbox.js';
import { buildReaction, buildReply, buildThread, type ThreadNode } from './thread.js';
import { createWallet, requestPersistence } from './wallet.js';

/** 데모 대상 계정. 이 사람의 inbox 는 유료 릴레이 하나뿐이다. */
const AUTHOR = '953878bc1ed3647168b5d0ddd29190bed95756c2296b8f48ded8a41b7c270841';
const MINT = 'https://mint.minibits.cash/Bitcoin';

const wallet = createWallet([MINT]);
const pool = wallet.pool;
const app = document.getElementById('app')!;

let tab: 'feed' | 'wallet' = 'feed';
let notes: Event[] = [];
let threads = new Map<string, ThreadNode>();
let profiles = new Map<string, { name?: string }>();
let status = '';

const short = (pk: string) => pk.slice(0, 8);
const nameOf = (pk: string) => profiles.get(pk)?.name ?? short(pk);
const when = (t: number) => new Date(t * 1000).toLocaleString('ko-KR');
const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

// ─── 데이터 ──────────────────────────────────────────────────────

async function loadFeed() {
  status = '아웃박스 조회 중…';
  render();

  // 이 사람이 **쓴** 글이므로 write 릴레이에서 (NIP-65).
  const { write } = await relayListFor(pool, AUTHOR);
  const relays = write.length ? write : BOOTSTRAP_RELAYS;
  notes = (await pool.querySync(relays, { authors: [AUTHOR], kinds: [1], limit: 5 }))
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, 5);

  const meta = await pool.querySync(relays, { authors: [AUTHOR], kinds: [0] });
  for (const m of meta) {
    try {
      profiles.set(m.pubkey, JSON.parse(m.content));
    } catch { /* 프로필이 깨져도 피드는 보여준다 */ }
  }

  status = '';
  render();
  for (const note of notes) void loadThread(note);
}

async function loadThread(note: Event) {
  // 이 노트에 **온** 답글이므로 작성자의 inbox 에서 (NIP-65). 재귀 없음 —
  // NIP-10 의 p 태그 누적 규정 덕에 한 번으로 전 depth 가 온다.
  const events = await fetchThread(pool, note);
  const tree = buildThread(note, events);

  // 리액션만 예외다. NIP-25 는 조상 태그를 안 물려받으므로 답글에 달린 리액션은
  // 그 답글 작성자의 inbox 에 있다 → 레벨당 1회 배치로 따로 모은다.
  const replies = events.filter((e) => e.kind === 1 || e.kind === 1111);
  if (replies.length) {
    const extra = await fetchReactionsFor(pool, replies);
    if (extra.length) {
      const merged = buildThread(note, [...events, ...extra]);
      threads.set(note.id, merged);
      render();
      return;
    }
  }
  threads.set(note.id, tree);
  render();
}

// ─── 발행 ────────────────────────────────────────────────────────

async function publish(event: Event): Promise<void> {
  // 표준대로 목적지를 계산한다: 내 write + p 태그된 사람들의 read.
  const targets = await publishTargetsFor(pool, event);
  const relays = targets.length ? targets : [DEMO_RELAY];
  const results = await Promise.allSettled(pool.publish(relays, event));

  const failed = results.filter((r) => r.status === 'rejected');
  const paymentIssue = failed.find(
    (r) => (r as PromiseRejectedResult).reason instanceof PaymentUnavailableError,
  ) as PromiseRejectedResult | undefined;

  if (paymentIssue) {
    // 일반 오류와 **구별해서** 알린다. 뭉개면 "상대에게 전달 안 됐는데 성공"이 된다.
    const e = paymentIssue.reason as PaymentUnavailableError;
    throw new Error(
      e.reason === 'no-payer'
        ? `${e.relayUrl} 은 유료 릴레이입니다. 지갑 탭에서 NWC 를 연결하세요.`
        : `결제하지 못해 ${e.relayUrl} 에 전달되지 않았습니다: ${e.message}`,
    );
  }
  if (failed.length === results.length) {
    throw new Error(`발행 실패: ${(failed[0] as PromiseRejectedResult)?.reason}`);
  }
}

async function submitReply(root: Event, parent: Event, content: string) {
  status = '발행 중…';
  render();
  try {
    // 릴레이 목록 광고는 **첫 덧글 때만**. 방문만 한 사람이 이벤트를 남기면 스팸이다.
    await announceRelayListOnce(async (ev, relays) => {
      await Promise.allSettled(pool.publish(relays, ev));
    });
    const event = sign(buildReply({ content, root, parent, relayHint: DEMO_RELAY }));
    await publish(event);
    await wallet.float.settle(event.id);
    status = '';
    await loadThread(root);
  } catch (e) {
    status = `⚠ ${(e as Error).message}`;
    render();
  }
}

async function react(root: Event, target: Event) {
  status = '리액션 발행 중…';
  render();
  try {
    await announceRelayListOnce(async (ev, relays) => {
      await Promise.allSettled(pool.publish(relays, ev));
    });
    const event = sign(buildReaction(target));
    await publish(event);
    await wallet.float.settle(event.id);
    status = '';
    await loadThread(root);
  } catch (e) {
    status = `⚠ ${(e as Error).message}`;
    render();
  }
}

// ─── 렌더 ────────────────────────────────────────────────────────

function renderNode(root: Event, node: ThreadNode): string {
  const isRoot = node.depth === 0;
  const paid = node.depth === 1;
  const reactions = node.reactions.length
    ? `<span class="dim small">${node.reactions.length}개 반응</span>`
    : '';

  const children = node.children
    .sort((a, b) => a.event.created_at - b.event.created_at)
    .map((c) => renderNode(root, c))
    .join('');

  const badge = isRoot
    ? ''
    : paid
      ? '<span class="badge paid">1 sat 지불됨</span>'
      : '<span class="badge free">무료 릴레이 경유 가능</span>';

  return `
    <div class="reply ${paid ? 'depth1' : ''}">
      <div class="meta">
        <b>${esc(nameOf(node.event.pubkey))}</b>
        <span class="mono">${short(node.event.pubkey)}</span>
        <span>${when(node.event.created_at)}</span>
        ${badge} ${reactions}
      </div>
      <div class="note-body">${esc(node.event.content)}</div>
      <div class="row" style="margin-top:8px">
        <button class="action" data-reply="${node.event.id}" data-root="${root.id}">답글</button>
        <button class="action" data-react="${node.event.id}" data-root="${root.id}">+</button>
      </div>
      <div data-form="${node.event.id}"></div>
      ${children}
    </div>`;
}

function renderFeed(): string {
  if (!notes.length) return `<div class="notice info">불러오는 중…</div>`;
  return notes
    .map((note) => {
      const tree = threads.get(note.id);
      const count = tree ? countReplies(tree) : 0;
      return `
      <article class="card">
        <div class="meta">
          <b>${esc(nameOf(note.pubkey))}</b>
          <span class="mono">${short(note.pubkey)}</span>
          <span>${when(note.created_at)}</span>
        </div>
        <div class="note-body" style="margin:8px 0">${esc(note.content)}</div>
        <div class="row">
          <button class="action" data-reply="${note.id}" data-root="${note.id}">답글</button>
          <button class="action" data-react="${note.id}" data-root="${note.id}">+</button>
          <span class="spacer"></span>
          <span class="dim small">${tree ? `답글 ${count}개` : '스레드 조회 중…'}</span>
        </div>
        <div data-form="${note.id}"></div>
        <div class="thread">${tree ? tree.children.map((c) => renderNode(note, c)).join('') : ''}</div>
      </article>`;
    })
    .join('');
}

function countReplies(node: ThreadNode): number {
  return node.children.reduce((n, c) => n + 1 + countReplies(c), 0);
}

let balances: Record<string, number> = {};
let spends: { at: number; sats: number; relayUrl: string }[] = [];

function renderWallet(): string {
  const nwcSet = Boolean(getNwc());
  const total = Object.values(balances).reduce((a, b) => a + b, 0);
  return `
    <div class="card">
      <h3 style="margin:0 0 10px;font-size:15px">지갑 연결 (NWC)</h3>
      ${
        nwcSet
          ? `<div class="notice info">연결됨. 이 데모는 이벤트당 1 sat 을 씁니다.</div>
             <button class="action" id="nwc-clear">연결 해제</button>`
          : `<div class="row"><input type="text" id="nwc-input" placeholder="nostr+walletconnect://..." /></div>
             <div class="row"><button class="action primary" id="nwc-save">연결</button></div>
             <div class="notice warn small">
               연결 문자열은 이 브라우저에 저장됩니다(모든 nostr 웹클라와 동일).
               <b>예산 한도가 걸린 전용 커넥션</b>을 쓰세요 — 라이브러리는 하드캡을 줄 수 없습니다.
             </div>`
      }
    </div>

    <div class="card">
      <h3 style="margin:0 0 10px;font-size:15px">float 잔액</h3>
      ${
        Object.keys(balances).length
          ? Object.entries(balances)
              .map(([m, s]) => `<div class="stat"><span class="mono small">${esc(m)}</span><b>${s} sat</b></div>`)
              .join('')
          : '<div class="dim small">아직 충전하지 않았습니다.</div>'
      }
      <div class="notice info small" style="margin-top:12px">
        ecash 는 베어러입니다. 브라우저 저장소는 내구성이 없으니(Safari 는 7일)
        잔액을 작게 유지하고, 다 쓰면 환불하세요.
      </div>
    </div>

    <div class="card">
      <h3 style="margin:0 0 10px;font-size:15px">지출 내역</h3>
      ${
        spends.length
          ? spends
              .slice(-20)
              .reverse()
              .map(
                (s) =>
                  `<div class="stat"><span class="small">${when(s.at / 1000)} <span class="dim mono">${esc(s.relayUrl)}</span></span><b>-${s.sats} sat</b></div>`,
              )
              .join('')
          : '<div class="dim small">아직 지출이 없습니다.</div>'
      }
    </div>

    <div class="card">
      <h3 style="margin:0 0 10px;font-size:15px">전액 환불</h3>
      <div class="row"><input type="text" id="refund-target" placeholder="라이트닝 주소 (user@domain) 또는 bolt11" /></div>
      <div class="row">
        <button class="action primary" id="refund-go" ${total < 2 ? 'disabled' : ''}>환불 (${total} sat)</button>
      </div>
      <div class="notice info small">
        melt 는 금액이 박힌 인보이스를 요구하는데 수수료를 미리 알 수 없습니다.
        <b>라이트닝 주소</b>를 주면 저희가 금액을 정해 인보이스를 받아 수렴시킵니다.
        (노드 펍키로는 불가 — melt 에 keysend 가 없습니다.)
      </div>
    </div>`;
}

function render() {
  app.innerHTML = `
    <header>
      <h1>pay-per-note</h1>
      <p>답글·멘션·리액션만 1 sat. 읽기와 플레인 노트는 무료입니다.</p>
    </header>
    <nav>
      <button data-tab="feed" aria-selected="${tab === 'feed'}">피드</button>
      <button data-tab="wallet" aria-selected="${tab === 'wallet'}">지갑</button>
    </nav>
    ${status ? `<div class="notice ${status.startsWith('⚠') ? 'warn' : 'info'}">${esc(status)}</div>` : ''}
    ${
      tab === 'feed'
        ? `<div class="notice info small">
             이 계정의 <b>inbox 릴레이는 유료 릴레이 하나뿐</b>입니다(NIP-65).
             그래서 여기 보이는 <b>depth 1 답글은 전부 값을 치른 것</b>입니다.
             더 깊은 답글은 각자의 inbox 를 거치므로 무료 릴레이를 탈 수 있습니다.
           </div>${renderFeed()}`
        : renderWallet()
    }`;
  wire();
}

// ─── 이벤트 배선 ─────────────────────────────────────────────────

function wire() {
  app.querySelectorAll<HTMLButtonElement>('nav button').forEach((b) => {
    b.onclick = () => {
      tab = b.dataset['tab'] as typeof tab;
      if (tab === 'wallet') void refreshWallet();
      else render();
    };
  });

  app.querySelectorAll<HTMLButtonElement>('[data-reply]').forEach((b) => {
    b.onclick = () => {
      const id = b.dataset['reply']!;
      const rootId = b.dataset['root']!;
      const slot = app.querySelector(`[data-form="${id}"]`)!;
      if (slot.innerHTML) {
        slot.innerHTML = '';
        return;
      }
      slot.innerHTML = `
        <div style="margin-top:8px">
          <textarea placeholder="답글을 입력하세요 (1 sat)"></textarea>
          <div class="row" style="margin-top:6px">
            <button class="action primary" data-send="${id}" data-root="${rootId}">보내기 · 1 sat</button>
          </div>
        </div>`;
      const send = slot.querySelector<HTMLButtonElement>('[data-send]')!;
      const ta = slot.querySelector('textarea')!;
      send.onclick = () => {
        const root = notes.find((n) => n.id === rootId)!;
        const parent = findEvent(rootId, id) ?? root;
        if (ta.value.trim()) void submitReply(root, parent, ta.value.trim());
      };
    };
  });

  app.querySelectorAll<HTMLButtonElement>('[data-react]').forEach((b) => {
    b.onclick = () => {
      const rootId = b.dataset['root']!;
      const root = notes.find((n) => n.id === rootId)!;
      const target = findEvent(rootId, b.dataset['react']!) ?? root;
      void react(root, target);
    };
  });

  const save = app.querySelector<HTMLButtonElement>('#nwc-save');
  if (save) {
    save.onclick = () => {
      const input = app.querySelector<HTMLInputElement>('#nwc-input')!;
      if (!input.value.trim()) return;
      setNwc(input.value.trim());
      location.reload();
    };
  }
  const clear = app.querySelector<HTMLButtonElement>('#nwc-clear');
  if (clear) clear.onclick = () => { setNwc(null); location.reload(); };

  const refund = app.querySelector<HTMLButtonElement>('#refund-go');
  if (refund) {
    refund.onclick = async () => {
      const target = app.querySelector<HTMLInputElement>('#refund-target')!.value.trim();
      if (!target) return;
      refund.disabled = true;
      status = '환불 중…';
      render();
      try {
        const out = target.includes('@')
          ? await wallet.float.refundToLightningAddress(target)
          : await wallet.float.refundAll();
        status = out.length ? `환불 완료: ${JSON.stringify(out)}` : '환불할 잔액이 없습니다.';
      } catch (e) {
        status = `⚠ ${(e as Error).message}`;
      }
      await refreshWallet();
    };
  }
}

function findEvent(rootId: string, id: string): Event | null {
  const tree = threads.get(rootId);
  if (!tree) return null;
  const walk = (n: ThreadNode): Event | null =>
    n.event.id === id ? n.event : n.children.reduce<Event | null>((f, c) => f ?? walk(c), null);
  return walk(tree);
}

async function refreshWallet() {
  balances = await wallet.float.balance();
  spends = await wallet.float.spendHistory();
  render();
}

// ─── 시작 ────────────────────────────────────────────────────────

void requestPersistence();
void wallet.float.reconcile().catch(() => {}); // 확정 못 받은 결제 회수
void loadFeed();
console.info('데모 신원:', myPubkey());

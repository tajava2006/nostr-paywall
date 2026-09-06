// A demo nostr client. It looks ordinary, and exactly one line differs from one:
//   new SimplePool()  →  new PaidPool({ payer })
// Subscriptions and queries are untouched. Reading is free.

import './style.css';
import type { Event } from 'nostr-tools/core';
import { PaymentUnavailableError } from '@nostr-paywall/client';
import { ABOUT_HTML } from './about.js';
import { checkMint, checkRelay, type Health } from './health.js';
import {
  DEMO_RELAY,
  announceRelayListOnce,
  getNwc,
  myPubkey,
  setNwc,
  sign,
} from './identity.js';
import { NwcClient, parseNwcUri } from './nwc.js';
import {
  BOOTSTRAP_RELAYS,
  fetchReactionsFor,
  fetchThread,
  publishTargetsFor,
  relayListFor,
} from './outbox.js';
import { cameraAvailable, scanQr } from './qr.js';
import { buildReaction, buildReply, buildThread, type ThreadNode } from './thread.js';
import { createWallet, requestPersistence, setTopUpAsker } from './wallet.js';

/** The account this demo reads. Its only inbox relay is the paid one. */
const AUTHOR = '953878bc1ed3647168b5d0ddd29190bed95756c2296b8f48ded8a41b7c270841';
const MINT = 'https://mint.minibits.cash/Bitcoin';
/** Where to open an event in a general-purpose client, for contrast. */
const VIEWER = 'https://jumble.social/notes/';

const wallet = createWallet([MINT]);
const pool = wallet.pool;
const app = document.getElementById('app')!;

type Tab = 'feed' | 'wallet' | 'about';
let tab: Tab = 'feed';
let notes: Event[] = [];
const threads = new Map<string, ThreadNode>();
const profiles = new Map<string, { name?: string; display_name?: string }>();
let status = '';
let relayHealth: Health = { state: 'checking' };
let mintHealth: Health = { state: 'checking' };

const short = (pk: string) => pk.slice(0, 8);
const nameOf = (pk: string) => {
  const p = profiles.get(pk);
  return p?.display_name || p?.name || short(pk);
};
const when = (ms: number) => new Date(ms).toLocaleString();
const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

// ─── data ────────────────────────────────────────────────────────

async function loadFeed() {
  status = 'Resolving relays (NIP-65)…';
  render();

  // Their own notes → their write relays.
  const { write } = await relayListFor(pool, AUTHOR);
  const relays = write.length ? write : BOOTSTRAP_RELAYS;
  notes = (await pool.querySync(relays, { authors: [AUTHOR], kinds: [1], limit: 5 }))
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, 5);

  for (const m of await pool.querySync(relays, { authors: [AUTHOR], kinds: [0] })) {
    try {
      profiles.set(m.pubkey, JSON.parse(m.content));
    } catch { /* a broken profile shouldn't hide the feed */ }
  }

  status = '';
  render();
  for (const note of notes) void loadThread(note);
}

async function loadThread(note: Event) {
  // Replies sent *to* this note → the author's inbox relays. No recursion:
  // NIP-10 makes replies inherit ancestor p tags, so one query covers every depth.
  const events = await fetchThread(pool, note);
  const replies = events.filter((e) => e.kind === 1 || e.kind === 1111);

  // Reactions are the exception — NIP-25 inherits nothing, so a reaction on a reply
  // lives in *that* author's inbox. One batched pass per level, not recursion.
  const extra = replies.length ? await fetchReactionsFor(pool, replies) : [];
  threads.set(note.id, buildThread(note, [...events, ...extra]));

  for (const ev of [...replies, ...extra]) {
    if (profiles.has(ev.pubkey)) continue;
    profiles.set(ev.pubkey, {});
  }
  render();
}

// ─── publishing ──────────────────────────────────────────────────

async function publish(event: Event): Promise<void> {
  // Standard targets: my write relays + the read relays of everyone p-tagged.
  // A reply to someone whose inbox is a free relay really does get published there.
  const targets = await publishTargetsFor(pool, event);
  const relays = targets.length ? targets : [DEMO_RELAY];
  const results = await Promise.allSettled(pool.publish(relays, event));

  const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
  const payment = rejected.find((r) => r.reason instanceof PaymentUnavailableError);
  if (payment) {
    // Keep this distinct from a generic failure. Blur them and you get
    // "the UI said sent, the recipient never got it".
    const e = payment.reason as PaymentUnavailableError;
    throw new Error(
      e.reason === 'no-payer'
        ? `${e.relayUrl} charges for this event. Connect a wallet in the Wallet tab.`
        : `Not delivered to ${e.relayUrl}: ${e.message}`,
    );
  }
  if (rejected.length === results.length) {
    throw new Error(`Publish failed: ${rejected[0]?.reason}`);
  }
}

async function withStatus(busy: string, fn: () => Promise<void>) {
  status = busy;
  render();
  try {
    await fn();
    status = '';
  } catch (e) {
    status = `⚠ ${(e as Error).message}`;
  }
  render();
}

function submitReply(root: Event, parent: Event, content: string) {
  return withStatus('Publishing…', async () => {
    // Announce our relay list on first write only — a visitor who just reads
    // shouldn't leave events behind.
    await announceRelayListOnce(async (ev, relays) => {
      await Promise.allSettled(pool.publish(relays, ev));
    });
    const event = sign(buildReply({ content, root, parent, relayHint: DEMO_RELAY }));
    await publish(event);
    await wallet.float.settle(event.id);
    await loadThread(root);
  });
}

function react(root: Event, target: Event) {
  return withStatus('Publishing reaction…', async () => {
    await announceRelayListOnce(async (ev, relays) => {
      await Promise.allSettled(pool.publish(relays, ev));
    });
    const event = sign(buildReaction(target));
    await publish(event);
    await wallet.float.settle(event.id);
    await loadThread(root);
  });
}

// ─── render: feed ────────────────────────────────────────────────

function renderNode(root: Event, node: ThreadNode): string {
  const reactions = node.reactions.length
    ? `<span class="dim small">${node.reactions.length} reaction${node.reactions.length > 1 ? 's' : ''}</span>`
    : '';
  const children = node.children
    .sort((a, b) => a.event.created_at - b.event.created_at)
    .map((c) => renderNode(root, c))
    .join('');

  return `
    <div class="reply">
      <div class="meta">
        <b>${esc(nameOf(node.event.pubkey))}</b>
        <span class="mono">${short(node.event.pubkey)}</span>
        <span>${when(node.event.created_at * 1000)}</span>
        ${reactions}
      </div>
      <div class="note-body">${esc(node.event.content)}</div>
      <div class="row" style="margin-top:8px">
        <button class="action" data-reply="${node.event.id}" data-root="${root.id}">Reply</button>
        <button class="action" data-react="${node.event.id}" data-root="${root.id}">+</button>
      </div>
      <div data-form="${node.event.id}"></div>
      ${children}
    </div>`;
}

const countReplies = (n: ThreadNode): number =>
  n.children.reduce((acc, c) => acc + 1 + countReplies(c), 0);

function renderFeed(): string {
  if (!notes.length) return `<div class="notice info">Loading…</div>`;
  return notes
    .map((note) => {
      const tree = threads.get(note.id);
      return `
      <article class="card">
        <div class="meta">
          <b>${esc(nameOf(note.pubkey))}</b>
          <span class="mono">${short(note.pubkey)}</span>
          <span>${when(note.created_at * 1000)}</span>
          <a class="dim small" href="${VIEWER}${note.id}" target="_blank" rel="noreferrer">open ↗</a>
        </div>
        <div class="note-body" style="margin:8px 0">${esc(note.content)}</div>
        <div class="row">
          <button class="action" data-reply="${note.id}" data-root="${note.id}">Reply · 1 sat</button>
          <button class="action" data-react="${note.id}" data-root="${note.id}">+</button>
          <span class="spacer"></span>
          <span class="dim small">${tree ? `${countReplies(tree)} replies` : 'loading thread…'}</span>
        </div>
        <div data-form="${note.id}"></div>
        <div class="thread">${tree ? tree.children.map((c) => renderNode(note, c)).join('') : ''}</div>
      </article>`;
    })
    .join('');
}

// ─── render: wallet ──────────────────────────────────────────────

let balances: Record<string, number> = {};
let spends: { at: number; mint: string; sats: number; eventId: string; relayUrl: string }[] = [];
let topUps: { at: number; sats: number }[] = [];
let refunds: { at: number; mint: string; sentSats: number; feeSats: number; target: string }[] = [];
let nwcBalanceSats: number | null = null;
let sweepHint = '';

function renderWallet(): string {
  const connected = Boolean(getNwc());
  const total = Object.values(balances).reduce((a, b) => a + b, 0);

  const history = [
    ...topUps.map((t) => ({ at: t.at, label: 'Top-up', amount: `+${t.sats}`, note: '' })),
    ...spends.map((s) => ({
      at: s.at,
      label: 'Publish',
      amount: `−${s.sats}`,
      // No outbound link: these events live only on the paid relay, so a general
      // client has nowhere to look them up. The id alone is the honest record.
      note: `<span class="mono dim">${s.eventId.slice(0, 12)}…</span> <span class="dim">${esc(s.relayUrl)}</span>`,
    })),
    ...refunds.map((r) => ({
      at: r.at,
      label: 'Refund',
      amount: `−${r.sentSats + r.feeSats}`,
      note: `<span class="dim">to ${esc(r.target)} · fee ${r.feeSats}</span>`,
    })),
  ].sort((a, b) => b.at - a.at);

  return `
    <div class="card">
      <h3>Lightning wallet (NWC)</h3>
      ${
        connected
          ? `<div class="stat"><span>Wallet balance</span><b>${nwcBalanceSats === null ? '—' : `${nwcBalanceSats} sat`}</b></div>
             <p class="dim small">Your actual lightning wallet, reached over NWC. Separate from the float below.</p>
             <button class="action" id="nwc-clear">Disconnect</button>`
          : `<div class="row"><input type="text" id="nwc-input" placeholder="nostr+walletconnect://…" /></div>
             <div class="row">
               <button class="action primary" id="nwc-save">Connect</button>
               ${cameraAvailable() ? '<button class="action" id="nwc-scan">Scan QR</button>' : ''}
             </div>
             <div class="notice warn small">
               The connection string is stored in this browser, like every other nostr web client.
               Use a <b>dedicated connection with a budget cap</b> — a library cannot enforce a hard cap for you.
             </div>`
      }
    </div>

    <div class="card">
      <h3>Ecash float</h3>
      <p class="dim small" style="margin-top:0">
        Bought from a mint with the wallet above, then spent one sat at a time.
        Held per mint — a token from one mint can't be spent at another.
      </p>
      ${
        Object.keys(balances).length
          ? Object.entries(balances)
              .map(
                ([m, s]) =>
                  `<div class="stat"><span class="mono small">${esc(m)}</span><b>${s} sat</b></div>`,
              )
              .join('')
          : '<div class="dim small">Nothing yet. Replying will offer to top up.</div>'
      }
      <div class="notice info small" style="margin-top:12px">
        Ecash is bearer money and browser storage is not durable (Safari clears it after 7 days).
        Keep the float small and sweep it when you're done.
      </div>
    </div>

    <div class="card">
      <h3>Sweep back to lightning</h3>
      <div class="row"><input type="text" id="refund-target" placeholder="lightning address (you@domain) or bolt11" /></div>
      <div class="row">
        <button class="action primary" id="refund-go" ${total < 2 ? 'disabled' : ''}>Sweep ${total} sat</button>
      </div>
      ${sweepHint ? `<div class="notice info small">${sweepHint}</div>` : ''}
      <div class="notice info small">
        Give a <b>lightning address</b> and the amount is worked out for you: melting needs an
        invoice for a fixed amount, but the routing fee is only known once the mint quotes it.
        A bare invoice is paid as-is, if the balance covers it.
        A raw node pubkey can't work — melt has no keysend.
      </div>
    </div>

    <div class="card">
      <h3>History</h3>
      ${
        history.length
          ? history
              .slice(0, 40)
              .map(
                (h) =>
                  `<div class="stat"><span class="small">${when(h.at)} · ${h.label} ${h.note}</span><b>${h.amount} sat</b></div>`,
              )
              .join('')
          : '<div class="dim small">No activity yet.</div>'
      }
    </div>`;
}

// ─── render ──────────────────────────────────────────────────────

function dot(h: Health): string {
  const color = h.state === 'up' ? 'var(--paid)' : h.state === 'down' ? 'var(--warn)' : 'var(--dim)';
  return `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${color}"></span>`;
}

function healthBar(): string {
  const line = (label: string, h: Health) =>
    `<span class="row" style="gap:6px">${dot(h)}<span class="small">${label}</span>
      <span class="dim small">${h.state === 'checking' ? 'checking…' : h.state === 'up' ? `${esc(h.detail)} · ${h.ms}ms` : esc(h.detail)}</span></span>`;
  return `<div class="row" style="gap:18px;flex-wrap:wrap;margin-bottom:12px">
    ${line('relay', relayHealth)}${line('mint', mintHealth)}
    <span class="spacer"></span>
    <button class="action" id="recheck">recheck</button>
  </div>`;
}

function render() {
  app.innerHTML = `
    <header>
      <h1>pay-per-note</h1>
      <p>Replies, mentions and reactions cost 1 sat. Reading and plain notes are free.</p>
    </header>
    <nav>
      <button data-tab="feed" aria-selected="${tab === 'feed'}">Feed</button>
      <button data-tab="wallet" aria-selected="${tab === 'wallet'}">Wallet</button>
      <button data-tab="about" aria-selected="${tab === 'about'}">Why</button>
    </nav>
    ${healthBar()}
    ${status ? `<div class="notice ${status.startsWith('⚠') ? 'warn' : 'info'}">${esc(status)}</div>` : ''}
    ${
      tab === 'feed'
        ? `<div class="notice info small">
             This account lists <b>one inbox relay</b> (NIP-65), and it charges.
             Replies are read from there and nowhere else — so every reply below was paid for.
             It also means replies published elsewhere are invisible here. That's the point.
           </div>${renderFeed()}`
        : tab === 'wallet'
          ? renderWallet()
          : ABOUT_HTML
    }`;
  wire();
}

// ─── wiring ──────────────────────────────────────────────────────

/**
 * Store an NWC connection string and restart.
 *
 * Validated before it is stored. An unparsable string would otherwise come back as a broken
 * wallet on every load, with nothing on screen saying why — and a mistyped paste or a QR that
 * turns out to hold something else both land here.
 */
function connectNwc(uri: string): void {
  const trimmed = uri.trim();
  if (!trimmed) return;
  parseNwcUri(trimmed); // throws; withStatus shows the reason
  setNwc(trimmed);
  location.reload();
}

function findEvent(rootId: string, id: string): Event | null {
  const tree = threads.get(rootId);
  const walk = (n: ThreadNode): Event | null =>
    n.event.id === id ? n.event : n.children.reduce<Event | null>((f, c) => f ?? walk(c), null);
  return tree ? walk(tree) : null;
}

function wire() {
  app.querySelectorAll<HTMLButtonElement>('nav button').forEach((b) => {
    b.onclick = () => {
      tab = b.dataset['tab'] as Tab;
      if (tab === 'wallet') void refreshWallet();
      else render();
    };
  });

  const recheck = app.querySelector<HTMLButtonElement>('#recheck');
  if (recheck) recheck.onclick = () => void checkHealth();

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
          <textarea placeholder="Your reply (1 sat)"></textarea>
          <div class="row" style="margin-top:6px">
            <button class="action primary" data-send>Send · 1 sat</button>
          </div>
        </div>`;
      const ta = slot.querySelector('textarea')!;
      slot.querySelector<HTMLButtonElement>('[data-send]')!.onclick = () => {
        const root = notes.find((n) => n.id === rootId)!;
        if (ta.value.trim()) void submitReply(root, findEvent(rootId, id) ?? root, ta.value.trim());
      };
    };
  });

  app.querySelectorAll<HTMLButtonElement>('[data-react]').forEach((b) => {
    b.onclick = () => {
      const rootId = b.dataset['root']!;
      const root = notes.find((n) => n.id === rootId)!;
      void react(root, findEvent(rootId, b.dataset['react']!) ?? root);
    };
  });

  const save = app.querySelector<HTMLButtonElement>('#nwc-save');
  if (save)
    save.onclick = () =>
      void withStatus('Connecting…', async () =>
        connectNwc(app.querySelector<HTMLInputElement>('#nwc-input')!.value),
      );

  const scan = app.querySelector<HTMLButtonElement>('#nwc-scan');
  if (scan)
    scan.onclick = () =>
      void withStatus('Opening the camera…', async () => {
        const text = await scanQr();
        if (!text) return; // cancelled
        app.querySelector<HTMLInputElement>('#nwc-input')!.value = text.trim();
        connectNwc(text);
      });

  const clear = app.querySelector<HTMLButtonElement>('#nwc-clear');
  if (clear)
    clear.onclick = () => {
      setNwc(null);
      location.reload();
    };

  const refund = app.querySelector<HTMLButtonElement>('#refund-go');
  if (refund)
    refund.onclick = async () => {
      const target = app.querySelector<HTMLInputElement>('#refund-target')!.value.trim();
      if (!target) return;
      await withStatus('Sweeping…', async () => {
        // `refundAll` (bare invoice) and `refundToLightningAddress` report different shapes.
        const out = target.includes('@')
          ? (await wallet.float.refundToLightningAddress(target)).map((o) => ({
              sent: o.sentSats,
              fee: o.feeSats,
            }))
          : (await wallet.float.refundAll()).map((o) => ({ sent: o.sats, fee: 0 }));
        sweepHint = out.length
          ? out.map((o) => `Sent ${o.sent} sat${o.fee ? ` (fee ${o.fee})` : ''}.`).join(' ')
          : 'Nothing to sweep.';
      });
      await refreshWallet();
    };
}

async function refreshWallet() {
  [balances, spends, topUps, refunds] = await Promise.all([
    wallet.float.balance(),
    wallet.float.spendHistory(),
    wallet.float.topUpHistory(),
    wallet.float.refundHistory(),
  ]);
  render();

  const uri = getNwc();
  if (uri) {
    try {
      nwcBalanceSats = Math.floor((await new NwcClient(uri).getBalance()).balance / 1000);
    } catch {
      nwcBalanceSats = null;
    }
    render();
  }
}

async function checkHealth() {
  relayHealth = { state: 'checking' };
  mintHealth = { state: 'checking' };
  render();
  [relayHealth, mintHealth] = await Promise.all([checkRelay(DEMO_RELAY), checkMint(MINT)]);
  render();
}

// ─── top-up consent (non-blocking) ───────────────────────────────
//
// `confirm()` freezes the main thread; the websocket then idles out and the
// following publish dies with "publish timed out". Ask in-page instead.

setTopUpAsker(
  ({ mint, sats }) =>
    new Promise<boolean>((resolve) => {
      const box = document.createElement('div');
      box.className = 'card';
      box.style.cssText =
        'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);max-width:520px;z-index:50';
      box.innerHTML = `
        <div><b>Not enough ecash.</b></div>
        <div class="small dim mono" style="margin:6px 0">${esc(mint)}</div>
        <div class="row" style="margin-top:8px">
          <button class="action primary" data-yes>Top up ${sats} sat</button>
          <button class="action" data-no>Cancel</button>
        </div>`;
      document.body.appendChild(box);
      const done = (v: boolean) => {
        box.remove();
        resolve(v);
      };
      box.querySelector('[data-yes]')!.addEventListener('click', () => done(true));
      box.querySelector('[data-no]')!.addEventListener('click', () => done(false));
    }),
);

// ─── start ───────────────────────────────────────────────────────

void requestPersistence();
void wallet.float.reconcile().catch(() => {}); // recover payments we never got an answer for
void checkHealth();
void loadFeed();
console.info('demo identity:', myPubkey());

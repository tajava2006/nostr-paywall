// The outbox model (NIP-65). The demo's argument lives here.
//
// Two rules:
//   - to read what someone **wrote**, use their **write** relays
//   - to read what was sent **to** them, use their **read** (inbox) relays
//
// So replies to a note are read from **the note author's inbox**. If that inbox charges,
// every reply sitting there was paid for.

import type { Event } from 'nostr-tools/core';
import type { Filter } from 'nostr-tools/filter';
import type { SimplePool } from 'nostr-tools/pool';

/** Where to look up kind 10002. NIP-65 calls these "well-known public indexers". */
export const BOOTSTRAP_RELAYS = [
  'wss://purplepag.es',
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.nostr.band',
];

export interface RelayList {
  /** Where to find what they wrote. */
  write: string[];
  /** Where to find what was sent to them: replies, mentions, reactions. */
  read: string[];
}

const cache = new Map<string, Promise<RelayList>>();

/**
 * Split kind 10002 into read and write.
 *
 * NIP-65: an `["r", url]` with **no marker means both**. Miss that and you lose the inbox
 * entirely.
 */
export function parseRelayList(event: Event | undefined): RelayList {
  const read: string[] = [];
  const write: string[] = [];
  for (const tag of event?.tags ?? []) {
    if (tag[0] !== 'r' || typeof tag[1] !== 'string') continue;
    const url = tag[1];
    const marker = tag[2];
    if (marker === 'read') read.push(url);
    else if (marker === 'write') write.push(url);
    else {
      read.push(url);
      write.push(url);
    }
  }
  return { read, write };
}

export function relayListFor(pool: SimplePool, pubkey: string): Promise<RelayList> {
  let p = cache.get(pubkey);
  if (!p) {
    p = (async () => {
      const events = await pool.querySync(BOOTSTRAP_RELAYS, {
        authors: [pubkey],
        kinds: [10002],
      });
      // Several relays may answer; take the newest (it is replaceable).
      const latest = events.sort((a, b) => b.created_at - a.created_at)[0];
      return parseRelayList(latest);
    })();
    cache.set(pubkey, p);
  }
  return p;
}

/** Relay lists for several people at once. */
export async function relayListsFor(
  pool: SimplePool,
  pubkeys: readonly string[],
): Promise<Map<string, RelayList>> {
  const unique = [...new Set(pubkeys)];
  const lists = await Promise.all(unique.map((pk) => relayListFor(pool, pk)));
  return new Map(unique.map((pk, i) => [pk, lists[i]!]));
}

/**
 * Group filters **by relay** so each one is queried once.
 *
 * Inboxes differ per person, so the naive loop hits the same relay repeatedly. Invert it
 * into `relayUrl → what to ask there`.
 */
export async function queryGrouped(
  pool: SimplePool,
  groups: Map<string, Filter>,
): Promise<Event[]> {
  const results = await Promise.all(
    [...groups].map(async ([relay, filter]) => {
      try {
        return await pool.querySync([relay], filter);
      } catch {
        return []; // one dead relay must not take the rest down
      }
    }),
  );
  const seen = new Set<string>();
  const out: Event[] = [];
  for (const ev of results.flat()) {
    if (seen.has(ev.id)) continue;
    seen.add(ev.id);
    out.push(ev);
  }
  return out;
}

/**
 * Fetch the **entire thread** under one note.
 *
 * No recursion. NIP-10 requires a reply to carry **all of its parent's `p` tags**, so a
 * reply at any depth still tags the root author and a spec-following client delivers it to
 * that author's inbox. The `root`-marked `e` tag survives at every depth too, so a single
 * `#e: [rootId]` query returns every level.
 *
 * We deliberately do **not** walk each replier's inbox to catch non-compliant clients.
 * Predicting broken behaviour explodes complexity, and it ends in "just blast it at a big
 * relay and it gets found" — which is centralisation, and which punishes the clients that
 * do follow the spec.
 */
export async function fetchThread(
  pool: SimplePool,
  rootNote: Event,
): Promise<Event[]> {
  const { read } = await relayListFor(pool, rootNote.pubkey);
  if (read.length === 0) return [];

  // `#e` covers NIP-10 replies (kind 1) and NIP-25 reactions.
  // `#E` is the **root** reference of a NIP-22 comment (kind 1111) — uppercase. Miss it and
  // comments vanish entirely.
  const groups = new Map<string, Filter>();
  for (const relay of read) {
    groups.set(relay, { '#e': [rootNote.id], kinds: [1, 7, 1111], limit: 500 });
  }
  const byE = await queryGrouped(pool, groups);

  const groupsUpper = new Map<string, Filter>();
  for (const relay of read) {
    groupsUpper.set(relay, { '#E': [rootNote.id], kinds: [1111], limit: 500 });
  }
  const byUpperE = await queryGrouped(pool, groupsUpper);

  const seen = new Set<string>();
  return [...byE, ...byUpperE].filter((e) => !seen.has(e.id) && seen.add(e.id));
}

/**
 * Collect **reactions** on the replies.
 *
 * Reactions (NIP-25) inherit nothing: `e` is the target event and `p` its author, and that
 * is all. So a reaction on a reply lives in **that replier's inbox**, not the root author's.
 * Handled as **one batched pass per level**, not recursion: the tree is already known, so
 * group by author and ask each relay once.
 */
export async function fetchReactionsFor(
  pool: SimplePool,
  events: readonly Event[],
): Promise<Event[]> {
  if (events.length === 0) return [];
  const lists = await relayListsFor(pool, events.map((e) => e.pubkey));

  // relayUrl → the event ids to ask about there
  const byRelay = new Map<string, Set<string>>();
  for (const ev of events) {
    for (const relay of lists.get(ev.pubkey)?.read ?? []) {
      const set = byRelay.get(relay) ?? new Set();
      set.add(ev.id);
      byRelay.set(relay, set);
    }
  }

  const groups = new Map<string, Filter>();
  for (const [relay, ids] of byRelay) {
    groups.set(relay, { '#e': [...ids], kinds: [7], limit: 500 });
  }
  return queryGrouped(pool, groups);
}

/**
 * Where an event should be published (NIP-65).
 *
 * - the author's **write** relays
 * - the **read** relays of everyone carrying a `p` tag
 *
 * Today that all collapses onto one relay, but we compute it properly anyway — the whole
 * claim of this demo is "this is what happens when you follow the spec".
 */
export async function publishTargetsFor(
  pool: SimplePool,
  event: { pubkey: string; tags: string[][] },
): Promise<string[]> {
  const tagged = event.tags.filter((t) => t[0] === 'p' && t[1]).map((t) => t[1]!);
  const lists = await relayListsFor(pool, [event.pubkey, ...tagged]);
  const targets = new Set<string>(lists.get(event.pubkey)?.write ?? []);
  for (const pk of tagged) {
    for (const relay of lists.get(pk)?.read ?? []) targets.add(relay);
  }
  return [...targets];
}

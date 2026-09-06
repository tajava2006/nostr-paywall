// 아웃박스 모델 (NIP-65) — 이 데모의 논지가 여기 있다.
//
// 규칙은 두 줄이다:
//   - 어떤 사람이 **쓴** 것을 읽으려면 → 그 사람의 **write** 릴레이
//   - 어떤 사람에게 **온** 것을 읽으려면 → 그 사람의 **read(inbox)** 릴레이
//
// 그래서 "이 노트에 달린 답글"은 **노트 작성자의 inbox** 에서 읽는다.
// 그 inbox 가 유료 릴레이라면 거기 있는 답글은 전부 값을 치른 것이다.

import type { Event } from 'nostr-tools/core';
import type { Filter } from 'nostr-tools/filter';
import type { SimplePool } from 'nostr-tools/pool';

/** kind 10002 를 찾기 위한 부트스트랩. NIP-65 가 말하는 "well-known public indexers". */
export const BOOTSTRAP_RELAYS = [
  'wss://purplepag.es',
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.nostr.band',
];

export interface RelayList {
  /** 이 사람이 쓴 글을 찾을 곳. */
  write: string[];
  /** 이 사람에게 온 글(답글·멘션·리액션)을 찾을 곳. */
  read: string[];
}

const cache = new Map<string, Promise<RelayList>>();

/**
 * kind 10002 를 읽어 read/write 로 가른다.
 *
 * NIP-65: `["r", url]` 처럼 **마커가 없으면 read 와 write 둘 다**다.
 * 이걸 놓치면 inbox 를 통째로 못 찾는다.
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
      // 여러 릴레이에서 오므로 최신 것을 고른다(replaceable).
      const latest = events.sort((a, b) => b.created_at - a.created_at)[0];
      return parseRelayList(latest);
    })();
    cache.set(pubkey, p);
  }
  return p;
}

/** 여러 사람의 릴레이 목록을 한 번에. */
export async function relayListsFor(
  pool: SimplePool,
  pubkeys: readonly string[],
): Promise<Map<string, RelayList>> {
  const unique = [...new Set(pubkeys)];
  const lists = await Promise.all(unique.map((pk) => relayListFor(pool, pk)));
  return new Map(unique.map((pk, i) => [pk, lists[i]!]));
}

/**
 * 필터를 **릴레이별로 묶어** 한 번씩만 질의한다.
 *
 * 사람마다 inbox 가 다르므로 순진하게 돌면 같은 릴레이를 여러 번 친다.
 * `relayUrl → 그 릴레이에서 물어볼 대상들` 로 뒤집어 묶는다.
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
        return []; // 한 릴레이가 죽어도 나머지는 계속
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
 * 노트 하나에 달린 **스레드 전체**를 가져온다.
 *
 * 재귀 탐색을 하지 않는다. NIP-10 이 "답글은 부모의 p 태그를 전부 물려받는다"고
 * 규정하므로([10.md] The "p" tag), 답글의 답글도 **루트 작성자의 p 태그를 갖고**
 * 따라서 표준을 지키는 클라라면 루트 작성자의 inbox 에 보낸다. `root` 마커가 붙은
 * `e` 태그도 깊이와 무관하게 유지되므로 `#e: [rootId]` 한 번으로 전 depth 가 온다.
 *
 * 재귀로 각 답글 작성자의 inbox 를 뒤지지 **않는** 이유: 비표준 클라의 동작을 예측하려
 * 들면 복잡도가 폭증하고, 결국 "큰 릴레이에 대충 뿌리면 다 찾아지네"가 되어
 * 중앙화를 부른다. 표준을 지키는 쪽이 손해 보는 구조를 만들지 않는다.
 */
export async function fetchThread(
  pool: SimplePool,
  rootNote: Event,
): Promise<Event[]> {
  const { read } = await relayListFor(pool, rootNote.pubkey);
  if (read.length === 0) return [];

  // `#e` = NIP-10 답글(kind 1)과 NIP-25 리액션.
  // `#E` = NIP-22 코멘트(kind 1111)의 **루트** 참조 — 대문자다. 놓치면 코멘트가 통째로 안 보인다.
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
 * 답글들에 달린 **리액션**을 모은다.
 *
 * 리액션(NIP-25)은 조상 태그를 물려받지 않는다 — `e` 는 대상 이벤트, `p` 는 대상
 * 작성자뿐이다. 그래서 답글에 달린 리액션은 **루트 작성자가 아니라 그 답글 작성자의
 * inbox** 에 있다. 재귀가 아니라 **레벨당 1회 배치**로 처리한다:
 * 트리를 이미 알고 있으니 작성자별로 묶어 릴레이마다 한 번씩만 물어본다.
 */
export async function fetchReactionsFor(
  pool: SimplePool,
  events: readonly Event[],
): Promise<Event[]> {
  if (events.length === 0) return [];
  const lists = await relayListsFor(pool, events.map((e) => e.pubkey));

  // relayUrl → 그 릴레이에서 물어볼 이벤트 id 들
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
 * 이벤트를 어디에 발행해야 하는가 (NIP-65).
 *
 * - 작성자의 **write** 릴레이
 * - `p` 태그된 모든 사람의 **read** 릴레이
 *
 * 지금은 전부 우리 릴레이 하나로 수렴하지만, 표준을 지켜 계산한다 —
 * 데모가 주장하는 게 바로 "표준을 지키면 이렇게 된다"이므로.
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

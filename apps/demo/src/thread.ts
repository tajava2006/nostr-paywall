// 스레드 조립 + 답글 작성 (NIP-10).

import type { Event, EventTemplate } from 'nostr-tools/core';

export interface ThreadNode {
  event: Event;
  children: ThreadNode[];
  reactions: Event[];
  /** 0 = 루트 노트. 1 = 유료 릴레이에 값을 치르고 들어온 답글. */
  depth: number;
}

/** `e` 태그에서 root/reply 를 뽑는다. 마커 방식(NIP-10 권장)과 위치 방식(구형) 둘 다. */
export function parentOf(event: Event): string | null {
  const eTags = event.tags.filter((t) => t[0] === 'e' && t[1]);
  if (eTags.length === 0) return null;

  const reply = eTags.find((t) => t[3] === 'reply');
  if (reply) return reply[1]!;
  const root = eTags.find((t) => t[3] === 'root');
  if (root) return root[1]!;

  // NIP-22 코멘트는 소문자 `e` 가 부모다(대문자 `E` 가 루트).
  if (event.kind === 1111) return eTags[0]![1]!;

  // 구형 위치 방식: 1개면 부모, 2개 이상이면 마지막이 부모.
  return eTags[eTags.length - 1]![1]!;
}

/** 리액션이 가리키는 대상. NIP-25 는 "다른 e 태그가 있으면 대상은 마지막"이라 규정한다. */
export function reactionTarget(event: Event): string | null {
  const eTags = event.tags.filter((t) => t[0] === 'e' && t[1]);
  return eTags.length ? eTags[eTags.length - 1]![1]! : null;
}

/**
 * 평평한 이벤트 목록을 트리로 조립한다.
 *
 * 부모를 못 찾은 답글은 **루트 직속으로 올린다** — 버리면 화면에서 사라져서
 * "돈 냈는데 안 보이는" 상태가 된다.
 */
export function buildThread(root: Event, events: readonly Event[]): ThreadNode {
  const rootNode: ThreadNode = { event: root, children: [], reactions: [], depth: 0 };
  const nodes = new Map<string, ThreadNode>([[root.id, rootNode]]);

  const replies = events
    .filter((e) => e.kind === 1 || e.kind === 1111)
    .sort((a, b) => a.created_at - b.created_at);
  for (const ev of replies) {
    if (nodes.has(ev.id)) continue;
    nodes.set(ev.id, { event: ev, children: [], reactions: [], depth: 0 });
  }

  for (const ev of replies) {
    const node = nodes.get(ev.id)!;
    const parent = nodes.get(parentOf(ev) ?? '') ?? rootNode;
    node.depth = parent.depth + 1;
    parent.children.push(node);
  }

  for (const ev of events) {
    if (ev.kind !== 7) continue;
    nodes.get(reactionTarget(ev) ?? '')?.reactions.push(ev);
  }
  return rootNode;
}

/**
 * 답글 이벤트를 만든다 (NIP-10 마커 방식).
 *
 * **`p` 태그를 부모에게서 전부 물려받는다.** 이게 이 데모의 아웃박스 전략을
 * 성립시키는 규정이다 — 덕분에 답글의 답글도 루트 작성자의 inbox 로 간다.
 */
export function buildReply(opts: {
  content: string;
  root: Event;
  parent: Event;
  relayHint: string;
}): EventTemplate {
  const { content, root, parent, relayHint } = opts;
  const tags: string[][] = [['e', root.id, relayHint, 'root', root.pubkey]];

  if (parent.id !== root.id) {
    tags.push(['e', parent.id, relayHint, 'reply', parent.pubkey]);
  }

  // 부모의 p 태그 전부 + 부모 작성자 (NIP-10)
  const pubkeys = new Set<string>([
    ...parent.tags.filter((t) => t[0] === 'p' && t[1]).map((t) => t[1]!),
    parent.pubkey,
  ]);
  for (const pk of pubkeys) tags.push(['p', pk, relayHint]);

  return { kind: 1, created_at: Math.floor(Date.now() / 1000), content, tags };
}

/** 리액션 (NIP-25). `e` 는 대상, `p` 는 대상 작성자 — 조상은 물려받지 않는다. */
export function buildReaction(target: Event, content = '+'): EventTemplate {
  return {
    kind: 7,
    created_at: Math.floor(Date.now() / 1000),
    content,
    tags: [
      ['e', target.id],
      ['p', target.pubkey],
      ['k', String(target.kind)],
    ],
  };
}

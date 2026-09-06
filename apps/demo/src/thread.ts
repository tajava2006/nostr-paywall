// Thread assembly and reply construction (NIP-10).

import type { Event, EventTemplate } from 'nostr-tools/core';

export interface ThreadNode {
  event: Event;
  children: ThreadNode[];
  reactions: Event[];
  /** 0 is the root note; 1 is a reply that reached the paid relay. */
  depth: number;
}

/** Find root/reply among the `e` tags. Handles both markers (preferred) and legacy positions. */
export function parentOf(event: Event): string | null {
  const eTags = event.tags.filter((t) => t[0] === 'e' && t[1]);
  if (eTags.length === 0) return null;

  const reply = eTags.find((t) => t[3] === 'reply');
  if (reply) return reply[1]!;
  const root = eTags.find((t) => t[3] === 'root');
  if (root) return root[1]!;

  // For a NIP-22 comment the lowercase `e` is the parent (uppercase `E` is the root).
  if (event.kind === 1111) return eTags[0]![1]!;

  // Legacy positional form: one tag is the parent; with more, the last one is.
  return eTags[eTags.length - 1]![1]!;
}

/** What a reaction points at. NIP-25 says the target is the last `e` tag if there are several. */
export function reactionTarget(event: Event): string | null {
  const eTags = event.tags.filter((t) => t[0] === 'e' && t[1]);
  return eTags.length ? eTags[eTags.length - 1]![1]! : null;
}

/**
 * Assemble a flat list of events into a tree.
 *
 * A reply whose parent is missing is **attached to the root** instead of dropped —
 * discarding it would mean "paid for, then invisible".
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
 * Build a reply (NIP-10, marker form).
 *
 * **Inherits every one of the parent's `p` tags.** That rule is what makes this demo's outbox
 * strategy work: it is why a reply to a reply still lands in the root author's inbox.
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

  // All of the parent's p tags, plus the parent's author (NIP-10)
  const pubkeys = new Set<string>([
    ...parent.tags.filter((t) => t[0] === 'p' && t[1]).map((t) => t[1]!),
    parent.pubkey,
  ]);
  for (const pk of pubkeys) tags.push(['p', pk, relayHint]);

  return { kind: 1, created_at: Math.floor(Date.now() / 1000), content, tags };
}

/** A reaction (NIP-25): `e` is the target, `p` its author. Nothing is inherited. */
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

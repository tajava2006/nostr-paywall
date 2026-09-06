// Demo identity: one random key per visitor, kept in the browser.
//
// There is no login. The only thing you can do here is reply, so demanding an account
// would be theatre. Clear browser storage and you're a new person.

import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import type { Event, EventTemplate } from 'nostr-tools/core';
import { bytesToHex, hexToBytes } from 'nostr-tools/utils';

const KEY = 'nostr-paywall-demo:sk';
const ANNOUNCED = 'nostr-paywall-demo:relay-list-announced';

export const DEMO_RELAY = 'wss://nostr.hoppe-relay.it.com';

export function getOrCreateKey(): Uint8Array {
  const saved = localStorage.getItem(KEY);
  if (saved) return hexToBytes(saved);
  const sk = generateSecretKey();
  localStorage.setItem(KEY, bytesToHex(sk));
  return sk;
}

export function myPubkey(): string {
  return getPublicKey(getOrCreateKey());
}

export function sign(template: EventTemplate): Event {
  return finalizeEvent(template, getOrCreateKey());
}

/**
 * Announce our relay list (kind 10002).
 *
 * Called on the **first write only**. A visitor who merely reads should not leave
 * events behind — that would be spam by our own definition.
 *
 * Advertises the paid relay as both read and write (no marker = both, NIP-65).
 * kind 10002 is not in the charged set, so this publish is free: the rule
 * "only charge what demands someone's attention" pays off right here.
 */
export async function announceRelayListOnce(
  publish: (event: Event, relays: string[]) => Promise<void>,
): Promise<void> {
  if (localStorage.getItem(ANNOUNCED)) return;
  const event = sign({
    kind: 10002,
    created_at: Math.floor(Date.now() / 1000),
    content: '',
    tags: [['r', DEMO_RELAY]],
  });
  await publish(event, [DEMO_RELAY]);
  localStorage.setItem(ANNOUNCED, String(Date.now()));
}

// ─── NWC connection string ───────────────────────────────────────
//
// Stored in the browser, same as every other nostr web client. The real defence
// is a dedicated connection with a budget cap, not where we put the string.

const NWC = 'nostr-paywall-demo:nwc';

export function getNwc(): string | null {
  return localStorage.getItem(NWC);
}

export function setNwc(uri: string | null): void {
  if (uri) localStorage.setItem(NWC, uri);
  else localStorage.removeItem(NWC);
}

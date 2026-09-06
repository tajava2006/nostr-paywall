// 데모 신원 — 방문자마다 브라우저에 랜덤 키 하나.
//
// 로그인이 없다. 데모에서 할 수 있는 일이 "덧글 달기"뿐이라 계정을 요구할 이유가 없다.
// 키는 브라우저에만 남고, 지우면 새 사람이 된다.

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
 * 내 릴레이 목록(kind 10002)을 알린다.
 *
 * **첫 덧글 시도 때만** 부른다. 방문만 한 사람이 이벤트를 남기면 그건 스팸이다.
 *
 * 유료 릴레이 하나를 read+write 로 광고한다(마커 없음 = 둘 다, NIP-65).
 * 우리 술어상 kind 10002 는 과금 대상이 아니라 이 발행은 공짜다 —
 * "남에게 노티가 가는 것만 과금"이라는 원칙이 여기서 그대로 작동한다.
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

// ─── NWC 연결 문자열 ─────────────────────────────────────────────
//
// 브라우저 저장소에 남는 건 모든 nostr 웹 클라와 같다. 예산 한도가 걸린
// 전용 커넥션을 쓰는 게 진짜 방어다.

const NWC = 'nostr-paywall-demo:nwc';

export function getNwc(): string | null {
  return localStorage.getItem(NWC);
}

export function setNwc(uri: string | null): void {
  if (uri) localStorage.setItem(NWC, uri);
  else localStorage.removeItem(NWC);
}

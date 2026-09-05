// `["EVENT", <event>, <payment>]` — 3원소 EVENT 메시지의 조립/해체.
//
// 왜 별도 이벤트가 아니라 3번째 원소인가(PLAN D2): 결제와 이벤트가 한 메시지에 있으면
// **구조가 곧 바인딩**이라 pending/orphan 상태·TTL·GC가 통째로 사라진다.

import { parsePaymentEnvelope } from './envelope.js';
import type { NostrEventLike, PaymentEnvelope } from './types.js';

export const EVENT_MESSAGE_TYPE = 'EVENT';

/** 표준 2원소 EVENT 메시지. 무료 이벤트·비유료 릴레이에 쓴다. */
export function encodeEventMessage(event: NostrEventLike): string;
/** 3원소. **유료 릴레이에만** 보낸다 — 나머지엔 표준 2원소라 생태계 무영향. */
export function encodeEventMessage(event: NostrEventLike, envelope: PaymentEnvelope): string;
export function encodeEventMessage(event: NostrEventLike, envelope?: PaymentEnvelope): string {
  const head = `["EVENT",${JSON.stringify(event)}`;
  return envelope === undefined ? `${head}]` : `${head},${JSON.stringify(envelope)}]`;
}

/**
 * 이미 직렬화된 EVENT 메시지 문자열에 봉투를 끼워 넣는다.
 *
 * nostr-tools의 `publish()`가 `this.send('["EVENT",' + JSON.stringify(event) + ']')`로
 * 하드코딩돼 있어서(abstract-relay.ts), public인 `send`를 갈아끼우고 여기서 문자열을
 * 손보는 게 유일하게 깔끔한 경로다. resolver 등록은 `publish()`가 해주므로 OK 수신은
 * 정상 동작한다. private 접근도, 포크도 필요 없다.
 *
 * EVENT 메시지가 아니거나 모양이 예상과 다르면 **원본을 그대로 돌려준다** —
 * 결제를 못 붙이는 건 발행 실패로 이어지지만, 여기서 문자열을 망가뜨리면
 * 무관한 메시지(REQ/CLOSE/AUTH)까지 깨진다.
 */
export function spliceEnvelope(rawMessage: string, envelope: PaymentEnvelope): string {
  const trimmed = rawMessage.trimEnd();
  if (!trimmed.startsWith('["EVENT"') || !trimmed.endsWith(']')) return rawMessage;
  return `${trimmed.slice(0, -1)},${JSON.stringify(envelope)}]`;
}

export interface SplitEventMessage {
  /** validator 에 넘길 표준 2원소 메시지(새 배열). */
  message: unknown[];
  /** 3번째 원소가 없거나 모양이 틀리면 `null`. */
  envelope: PaymentEnvelope | null;
}

/**
 * 릴레이 진입점에서 봉투를 떼어낸다 — **검증 전에** 불러야 한다.
 *
 * `@nostr-relay/validator`의 EVENT 스키마가
 * `z.tuple([z.literal('EVENT'), eventSchema])`라 여분 원소를 거부하기 때문이다
 * (실측: `Array must contain at most 2 element(s)`). 우리 포크의
 * `nostr-relay.service.ts`에서 `validateIncomingMessage()` 앞에 이걸 끼우면
 * `@nostr-relay/*` npm 패키지는 하나도 포크하지 않아도 된다(PLAN §5.1).
 *
 * 봉투가 깨졌어도 메시지 자체는 통과시킨다. 그래야 이벤트가 정상 검증을 거쳐
 * `payment-required`라는 **정확한 이유**로 거부된다 — 파싱 실패로 뭉개면
 * 클라가 재시도해야 할지 말지를 알 수 없다.
 */
export function takePaymentEnvelope(data: unknown): SplitEventMessage | null {
  if (!Array.isArray(data)) return null;
  if (data[0] !== EVENT_MESSAGE_TYPE) return null;
  if (data.length <= 2) return { message: data.slice(0, 2), envelope: null };
  return { message: data.slice(0, 2), envelope: parsePaymentEnvelope(data[2]) };
}

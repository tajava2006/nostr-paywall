// 발행 흐름 — 풀 구현과 분리해 둔다.
//
// nostr-tools 의 `SimplePool` 을 상속하지 않고 **릴레이 하나에 대한 발행**만 다루므로,
// 다른 풀 구현(NDK 등)에 얹을 때도 이 파일을 그대로 재사용할 수 있다(PLAN §6.7).

import {
  parseOkReason,
  parsePaymentTerms,
  priceFor,
  spliceEnvelope,
  type NostrEventLike,
  type PaymentEnvelope,
} from '@nostr-paywall/protocol';
import {
  PaymentUnavailableError,
  type Payer,
  type RelayPolicy,
} from './types.js';

/** nostr-tools 의 `AbstractRelay` 중 우리가 쓰는 부분만. */
export interface RelayLike {
  url: string;
  send(message: string): Promise<void> | void;
  publish(event: NostrEventLike): Promise<string>;
}

export interface PublishDeps {
  payer: Payer;
  /**
   * 릴레이 핸들을 **매번 새로 얻는다.**
   *
   * 결제가 두 발행 시도 사이에 끼어 있어서(사용자 확인 + LN 결제) 그동안
   * 풀의 idle 타임아웃(기본 20s)이 연결을 닫아버린다. 닫힌 핸들로 재발행하면
   * 재연결을 기다리다 publish 타임아웃(4.4s)에 걸려 `publish timed out` 이 난다.
   * 실측으로 잡은 문제 — 결제 직전에 다시 얻어야 한다.
   */
  getRelay(): Promise<RelayLike>;
  getPolicy(url: string): RelayPolicy;
  setPolicy(url: string, policy: RelayPolicy): void;
  /** NIP-11 문서를 가져온다. 거부당한 뒤에만 부른다(PLAN D8). */
  fetchRelayInformation(url: string): Promise<unknown>;
}

/**
 * 이미 직렬화된 EVENT 메시지에 봉투를 끼워 넣는다.
 *
 * nostr-tools 의 `publish()` 는 두 가지를 하는데 — resolver 등록과 전송 —
 * resolver 맵이 private 이라 우리가 직접 못 만진다. 그래서 **public 인 `send` 를
 * 인스턴스에 덮어씌워** 문자열만 손보고 `publish()` 는 그대로 쓴다.
 * OK 상관관계는 `publish()` 가 등록해주므로 정상 동작한다.
 *
 * one-shot 이다 — 첫 호출에서 원래 `send` 로 되돌린다. 같은 릴레이에 동시
 * 발행이 겹칠 수 있으므로 event.id 로 대상을 확인한다.
 */
async function publishWithEnvelope(
  relay: RelayLike,
  event: NostrEventLike,
  envelope: PaymentEnvelope,
): Promise<string> {
  // 원본을 **참조 그대로** 보존한다. bind() 로 감싸면 복구해도 다른 함수가 되고,
  // 다른 래퍼가 겹겹이 쌓였을 때 누가 원본인지 알 수 없게 된다.
  const originalSend = relay.send;
  const ownSend = Object.prototype.hasOwnProperty.call(relay, 'send');
  const call = (message: string) => originalSend.call(relay, message);

  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    // 프로토타입 메서드였다면 own 프로퍼티를 지워 원래 모양으로 되돌린다.
    if (ownSend) (relay as { send: RelayLike['send'] }).send = originalSend;
    else delete (relay as Partial<RelayLike>).send;
  };

  (relay as { send: RelayLike['send'] }).send = (message: string) => {
    // 우리 이벤트가 아니면 손대지 않고 흘려보낸다(동시 발행 보호).
    if (!message.includes(event.id)) return call(message);
    restore();
    return call(spliceEnvelope(message, envelope));
  };

  try {
    return await relay.publish(event);
  } finally {
    restore();
  }
}

async function pay(
  deps: PublishDeps,
  relayUrl: string,
  event: NostrEventLike,
  policy: Extract<RelayPolicy, { kind: 'paid' }>,
  amountMsat: number,
): Promise<PaymentEnvelope> {
  const payFn = deps.payer(relayUrl);
  if (!payFn) {
    throw new PaymentUnavailableError(
      relayUrl,
      'no-payer',
      `${relayUrl} 은 발행에 ${amountMsat / 1000} sat 를 요구하는데 지불 수단이 없다`,
    );
  }

  let envelope: PaymentEnvelope | null;
  try {
    envelope = await payFn({ relayUrl, event, terms: policy.terms, amountMsat });
  } catch (e) {
    throw new PaymentUnavailableError(relayUrl, 'failed', `결제 실패: ${(e as Error).message}`);
  }
  if (!envelope) {
    throw new PaymentUnavailableError(relayUrl, 'declined', `${relayUrl} 에 대한 결제가 거부됨`);
  }
  return envelope;
}

/**
 * 릴레이 하나에 발행한다. 필요하면 결제를 붙인다.
 *
 * - 모르는 릴레이 → 표준 2원소로 보내보고, 거부당하면 NIP-11 을 읽어 학습한 뒤 재시도
 * - 무료로 학습된 릴레이 → 2원소 (생태계 무영향)
 * - 유료로 학습된 릴레이 → 술어를 **로컬 평가**해서 과금 대상이면 1-shot 3원소
 */
export async function publishToRelay(
  deps: PublishDeps,
  url: string,
  event: NostrEventLike,
): Promise<string> {
  const policy = deps.getPolicy(url);

  if (policy.kind === 'paid') {
    const price = priceFor(event, policy.terms);
    if (!price.charge) return (await deps.getRelay()).publish(event);
    if (!policy.terms.envelopeInEventMessage) {
      throw new PaymentUnavailableError(
        url,
        'unsupported',
        `${url} 은 결제를 요구하지만 EVENT 메시지 봉투를 받지 않는다`,
      );
    }
    const envelope = await pay(deps, url, event, policy, price.amountMsat);
    // 결제 뒤에 다시 얻는다 — 그 사이 연결이 닫혔을 수 있다.
    return publishWithEnvelope(await deps.getRelay(), event, envelope);
  }

  // 'unknown' | 'free' — 일단 표준 형태로 보낸다.
  try {
    // 성공했다고 `free` 로 단정하지 않는다. 첫 발행이 플레인 노트면 유료 릴레이도
    // 그냥 받아주므로 "무료"는 근거 없는 주장이 된다(실측으로 확인).
    // `unknown` 과 `free` 는 동작이 같으므로 잃는 것도 없다.
    //
    // ⚠️ `await` 필수. try 블록에서 await 없이 promise 를 return 하면 rejection 이
    // catch 로 안 온다 — 학습 경로가 통째로 죽는다(실측으로 잡음).
    return await (await deps.getRelay()).publish(event);
  } catch (e) {
    // ⚠️ 거부값이 Error 라는 보장이 없다. nostr-tools 의 `connect()` 는
    // `reject('connection timed out')` 처럼 **문자열**로 거부한다(abstract-relay.ts).
    // `(e as Error).message` 로 읽으면 undefined 가 되고, 그게 파서에서 터지면서
    // **진짜 원인(연결 실패)을 TypeError 로 덮어버린다** — 실측으로 겪었다.
    const reason = e instanceof Error ? e.message : typeof e === 'string' ? e : String(e);
    const outcome = parseOkReason(false, reason);
    if (outcome.kind !== 'payment-required') throw e;

    // 여기서야 NIP-11 을 읽는다. 선제적으로 읽는 클라는 없지만
    // 거부당한 뒤엔 읽는다 — 웹소켓과 같은 URL 이라 엔드포인트 설정도 필요 없다.
    const terms = parsePaymentTerms(await deps.fetchRelayInformation(url));
    if (!terms) {
      throw new PaymentUnavailableError(
        url,
        'unsupported',
        `${url} 이 결제를 요구하는데 NIP-11 에서 조건을 읽을 수 없다: ${outcome.message}`,
      );
    }
    const learned: RelayPolicy = { kind: 'paid', terms, learnedAt: Date.now() };
    deps.setPolicy(url, learned);

    const price = priceFor(event, terms);
    // 릴레이는 돈을 요구했는데 우리 술어는 무료라고 한다 = 정책 해석이 갈렸다.
    // 조용히 재시도하면 무한 루프가 되므로 여기서 끊는다.
    if (!price.charge) {
      throw new PaymentUnavailableError(
        url,
        'unsupported',
        `${url} 이 결제를 요구했지만 광고된 조건상 이 이벤트는 무료다 — 릴레이 정책 불일치`,
      );
    }
    const envelope = await pay(deps, url, event, learned, price.amountMsat);
    return publishWithEnvelope(await deps.getRelay(), event, envelope);
  }
}

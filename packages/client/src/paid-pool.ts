// `SimplePool` 드롭인 교체.
//
// 앱 변경량은 생성자 한 줄 + 결제 콜백 배선이 전부다. `subscribe` 계열은 손대지 않는다
// (읽기는 무료다). `publish` 만 오버라이드한다.

// ⚠️ 서브패스(`nostr-tools/pool` 등)가 아니라 **루트에서** 가져온다.
// CJS 빌드는 moduleResolution 이 낮아 서브패스 exports 맵을 못 읽는다
// (`Cannot find module 'nostr-tools/pool'`). 루트는 어느 해석기에서도 잡힌다.
import { SimplePool, nip11, utils, type Event, type EventTemplate, type VerifiedEvent } from 'nostr-tools';
import { publishToRelay, type RelayLike } from './publisher.js';
import type { Payer, PolicyStore, RelayPolicy } from './types.js';

export interface PaidPoolOptions {
  /** 결제 능력. 없으면 유료 릴레이 발행이 `PaymentUnavailableError` 로 실패한다. */
  payer?: Payer;
  /** 릴레이 정책 캐시를 앱이 영속화하고 싶을 때. 없으면 메모리. */
  policyStore?: PolicyStore;
  /** NIP-11 fetch 교체(테스트·커스텀 전송). */
  fetchRelayInformation?: (url: string) => Promise<unknown>;
}

const UNKNOWN: RelayPolicy = { kind: 'unknown' };

export class PaidPool extends SimplePool {
  private readonly policies = new Map<string, RelayPolicy>();
  private readonly opts: PaidPoolOptions;
  private hydrated: Promise<void> | undefined;

  constructor(opts: PaidPoolOptions = {}) {
    super();
    this.opts = opts;
  }

  /**
   * 학습된 릴레이 정책. UI 에 "이 릴레이는 유료" 를 띄우고 싶을 때 쓴다.
   *
   * ⚠️ 키는 **정규화된 URL** 이다. nostr-tools 가 `wss://x.com` 을 `wss://x.com/` 로
   * 바꾸므로, 정규화 없이 넣고 빼면 캐시가 영원히 빗나가 1-shot 경로가 안 켜진다
   * (실측으로 잡음 — 매번 왕복 2회를 돌고 있었다).
   */
  getPolicy(url: string): RelayPolicy {
    return this.policies.get(utils.normalizeURL(url)) ?? UNKNOWN;
  }

  setPolicy(url: string, policy: RelayPolicy): void {
    this.policies.set(utils.normalizeURL(url), policy);
    void this.opts.policyStore?.save(Object.fromEntries(this.policies));
  }

  private async hydrate(): Promise<void> {
    if (!this.opts.policyStore) return;
    this.hydrated ??= (async () => {
      const saved = await this.opts.policyStore!.load();
      for (const [url, policy] of Object.entries(saved ?? {})) {
        if (!this.policies.has(url)) this.policies.set(url, policy);
      }
    })();
    return this.hydrated;
  }

  /**
   * 릴레이별 발행. 유료면 결제를 붙인다.
   *
   * `SimplePool.publish` 와 시그니처가 같아 드롭인이다 — 릴레이별 promise 배열을
   * 돌려주고, 유료 릴레이에서 지불 수단이 없으면 그 항목만
   * `PaymentUnavailableError` 로 reject 된다. **일반 오류와 구별해서 UI 에 알릴 것**
   * (안 그러면 답글이 상대에게 전달 안 됐는데 성공으로 보인다).
   */
  publish(relays: string[], event: Event): Promise<string>[] {
    return relays.map(async (url) => {
      await this.hydrate();
      return publishToRelay(
        {
          payer: this.opts.payer ?? (() => null),
          // 매번 새로 얻는다. 결제로 시간이 흐르는 동안 연결이 닫힐 수 있다.
          getRelay: async () => (await this.ensureRelay(url)) as unknown as RelayLike,
          getPolicy: (u) => this.getPolicy(u),
          setPolicy: (u, p) => this.setPolicy(u, p),
          fetchRelayInformation:
            this.opts.fetchRelayInformation ??
            ((u) => nip11.fetchRelayInformation(u) as Promise<unknown>),
        },
        url,
        event,
      );
    });
  }
}

export type { Event, EventTemplate, VerifiedEvent };

// A drop-in replacement for `SimplePool`.
//
// The app changes one constructor plus the payment wiring. Subscriptions are untouched
// (reading is free); only `publish` is overridden.

// Import from the **package root**, not subpaths (`nostr-tools/pool` and friends): the CJS
// build resolves with a lower moduleResolution that cannot read the subpath exports map
// (`Cannot find module 'nostr-tools/pool'`). The root resolves everywhere.
import { SimplePool, nip11, utils, type Event, type EventTemplate, type VerifiedEvent } from 'nostr-tools';
import { publishToRelay, type RelayLike } from './publisher.js';
import type { Payer, PolicyStore, RelayPolicy } from './types.js';

export interface PaidPoolOptions {
  /** Payment capability. Without it, publishing to a paid relay fails with `PaymentUnavailableError`. */
  payer?: Payer;
  /** For apps that want to persist the relay policy cache. Memory otherwise. */
  policyStore?: PolicyStore;
  /** Override the NIP-11 fetch (tests, custom transports). */
  fetchRelayInformation?: (url: string) => Promise<unknown>;
}

const UNKNOWN: RelayPolicy = { kind: 'unknown' };

export class PaidPool extends SimplePool {
  /** Reconnect budget after payment. The 3s default is short right after a lightning payment. */
  connectionTimeoutMs = 10_000;
  private readonly policies = new Map<string, RelayPolicy>();
  private readonly opts: PaidPoolOptions;
  private hydrated: Promise<void> | undefined;

  constructor(opts: PaidPoolOptions = {}) {
    super();
    this.opts = opts;
  }

  /**
   * The learned relay policy — use it to show "this relay charges" in a UI.
   *
   * Keys are **normalised URLs**. nostr-tools rewrites `wss://x.com` to `wss://x.com/`, so
   * storing and reading without normalising misses forever and the single-round-trip path
   * never engages (measured: every publish was doing two round trips).
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
   * Publish per relay, attaching payment where required.
   *
   * Same signature as `SimplePool.publish`, so it is a drop-in: one promise per relay, and a
   * paid relay with no payment method rejects that entry with `PaymentUnavailableError`.
   * **Report it distinctly** — otherwise a reply silently fails to reach its recipient while
   * the UI claims success.
   */
  publish(relays: string[], event: Event): Promise<string>[] {
    return relays.map(async (url) => {
      await this.hydrate();
      return publishToRelay(
        {
          payer: this.opts.payer ?? (() => null),
          // Fetched each time: the connection can close while payment is in flight.
          // Allow a generous reconnect budget, since this happens right after a payment.
          getRelay: async () =>
            (await this.ensureRelay(url, {
              connectionTimeout: this.connectionTimeoutMs,
            })) as unknown as RelayLike,
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

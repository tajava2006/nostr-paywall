// Wallet wiring: NWC ↔ float ↔ PaidPool.
//
// The app hands the library two functions, `payInvoice` and `makeInvoice` — never the
// NWC connection string. Handing over the string would give the library the app's whole
// budget and force it to reimplement an NWC client.

import {
  EcashFloat,
  IndexedDbFloatStore,
  createFloatPayer,
  type Funding,
} from '@nostr-paywall/float';
import { PaidPool } from '@nostr-paywall/client';
import { getNwc } from './identity.js';
import { NwcClient } from './nwc.js';

function fundingFromNwc(uri: string): Funding {
  const client = new NwcClient(uri);
  return {
    payInvoice: (bolt11) => client.payInvoice(bolt11),
    makeInvoice: async (amountSats) =>
      (await client.makeInvoice(amountSats * 1000, 'nostr-paywall float refund')).invoice,
  };
}

const noFunding: Funding = {
  async payInvoice() {
    throw new Error('no wallet connected');
  },
};

export interface Wallet {
  float: EcashFloat;
  pool: PaidPool;
  connected: boolean;
}

/**
 * Build the wallet. Without NWC the float still exists but cannot be topped up; publishing
 * to a paid relay then raises `PaymentUnavailableError`, which the UI must show **distinctly**
 * from a generic error.
 */
export function createWallet(allowedMints: string[]): Wallet {
  const uri = getNwc();
  const float = new EcashFloat({
    store: new IndexedDbFloatStore(),
    funding: uri ? fundingFromNwc(uri) : noFunding,
    limits: { maxFloatSats: 500, maxTopUpPerPeriodSats: 2000 },
    topUpSats: 100,
    // Constructing the library must never spend money, so always ask.
    //
    // **Never use a blocking dialog like `confirm()`**: while the main thread is frozen the
    // websocket and timers stop, the relay connection idles out, and the following publish
    // dies with `publish timed out` (measured). Ask without blocking.
    onTopUpRequired: (info) => askTopUp(info),
  });

  const pool = new PaidPool({
    payer: createFloatPayer(float, { allowedMints }),
  });
  // Payment (confirmation plus lightning) sits between the two publish attempts, so the
  // 20s default closes the connection underneath us.
  pool.idleTimeout = 0;

  return { float, pool, connected: Boolean(uri) };
}

/** Non-blocking top-up consent: the app asks on screen and answers with a promise. */
let topUpAsker: ((info: { mint: string; sats: number }) => Promise<boolean>) | undefined;

export function setTopUpAsker(fn: typeof topUpAsker): void {
  topUpAsker = fn;
}

function askTopUp(info: { mint: string; sats: number }): Promise<boolean> {
  return topUpAsker ? topUpAsker(info) : Promise.resolve(false);
}

/** Ask not to be evicted. If refused, lowering the float cap is the right response. */
export async function requestPersistence(): Promise<boolean> {
  return IndexedDbFloatStore.requestPersistence();
}

// 지갑 배선 — NWC ↔ float ↔ PaidPool.
//
// 앱이 라이브러리에 주는 건 `payInvoice`/`makeInvoice` 두 개뿐이다.
// NWC 연결 문자열 자체는 넘기지 않는다 — 넘기면 앱 전체 예산을 통째로 상속시키는 꼴이고,
// 라이브러리가 NWC 클라이언트를 재구현하게 된다.

import {
  EcashFloat,
  IndexedDbFloatStore,
  createFloatPayer,
  type Funding,
} from '@nostr-paywall/float';
import { PaidPool } from '@nostr-paywall/client';
import { getNwc } from './identity.js';
import { NwcClient } from './nwc.js';

/** 앱이 이미 갖고 있는 결제 수단을 라이브러리에 물려준다. URI 는 넘기지 않는다. */
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
    throw new Error('지갑이 연결되지 않았다');
  },
};

export interface Wallet {
  float: EcashFloat;
  pool: PaidPool;
  connected: boolean;
}

/**
 * 지갑을 만든다. NWC 가 없으면 float 은 살아 있되 충전을 못 한다 —
 * 그 상태로 유료 릴레이에 발행하면 `PaymentUnavailableError` 가 나고,
 * UI 는 그걸 일반 오류와 **구별해서** 보여줘야 한다.
 */
export function createWallet(allowedMints: string[]): Wallet {
  const uri = getNwc();
  const float = new EcashFloat({
    store: new IndexedDbFloatStore(),
    funding: uri ? fundingFromNwc(uri) : noFunding,
    limits: { maxFloatSats: 500, maxTopUpPerPeriodSats: 2000 },
    topUpSats: 100,
    // 라이브러리 init 만으로 돈이 나가면 안 된다. 항상 물어본다.
    onTopUpRequired: async ({ sats, mint }) =>
      confirm(`잔액이 부족합니다.\n\n${mint}\n에서 ${sats} sat 을 충전할까요?`),
  });

  const pool = new PaidPool({
    payer: createFloatPayer(float, { allowedMints }),
  });

  return { float, pool, connected: Boolean(uri) };
}

/** 저장소 축출 방어. 승인 못 받으면 float 상한을 더 낮추는 게 맞다. */
export async function requestPersistence(): Promise<boolean> {
  return IndexedDbFloatStore.requestPersistence();
}

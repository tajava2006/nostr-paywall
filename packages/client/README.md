# @nostr-paywall/client

A drop-in `SimplePool` replacement that attaches payment when a relay asks for it.

```ts
import { PaidPool, PaymentUnavailableError } from '@nostr-paywall/client';

const pool = new PaidPool({
  payer: (relayUrl) => async (req) => {
    // req: { relayUrl, event, terms, amountMsat }
    // Your app keeps the wallet. Return null to decline.
    return myWallet.makeEnvelope(req);
  },
});

await Promise.all(pool.publish(relays, event));   // otherwise identical to SimplePool
```

Subscriptions and queries are untouched — reading is free.

## Behaviour

- **Unknown relay** → publish the standard two-element message. Succeeding does **not** prove the
  relay is free: a plain note is accepted by paid relays too.
- **On `payment-required`** → fetch the relay's NIP-11 document, learn the terms, pay, republish.
  Reading NIP-11 reactively is the only time anyone reads it at all.
- **Once learned** → evaluate the predicate locally and send chargeable events as a single
  three-element message. Free events still cost nothing.

## Report payment failures distinctly

```ts
const results = await Promise.allSettled(pool.publish(relays, event));
for (const r of results) {
  if (r.status === 'rejected' && r.reason instanceof PaymentUnavailableError) {
    // 'no-payer' | 'declined' | 'failed' | 'unsupported'
    toast(`Not delivered to ${r.reason.relayUrl}`);
  }
}
```

A paid relay is usually the **recipient's inbox relay**. Fold this into a generic error and you
ship the worst failure mode there is: the UI says sent, the reply never arrives.

Design notes: https://github.com/tajava2006/nostr-paywall

> Proof of concept.

# @nostr-paywall/float

Client-side ecash float. Top up once over NWC, spend a sat per event, sweep the rest back.

```ts
import { EcashFloat, createFloatPayer, createDefaultStore } from '@nostr-paywall/float';
import { PaidPool } from '@nostr-paywall/client';

const float = new EcashFloat({
  store: createDefaultStore(),        // IndexedDB in a browser/Tauri, a file under Node
  funding: {
    payInvoice: (bolt11) => app.wallet.payInvoice(bolt11),   // top up
    makeInvoice: (sats) => app.wallet.makeInvoice(sats),     // sweep back
  },
  limits: { maxFloatSats: 500, maxTopUpPerPeriodSats: 2000 },
  onTopUpRequired: async ({ sats }) => askTheUser(sats),
});

const pool = new PaidPool({ payer: createFloatPayer(float) });
```

## Why the library holds money

NWC has no keysend in its core method set, so an app cannot pay a relay directly whatever rail
the relay wants. But a **mint quote returns a bolt11 invoice** (NUT-04), so `pay_invoice` alone is
enough to buy ecash — and that's the only path to being rail-agnostic. The app supplies two
functions and never the connection string.

## Safety

- **`autoTopUp` defaults to false.** Constructing a library must never spend a user's money.
- **Limits here are bookkeeping, not a guarantee.** A real hard cap only comes from the budget on
  a dedicated NWC connection.
- **Keep the float small.** Browser storage isn't durable (Safari clears it after 7 days) and
  ecash is bearer money, so XSS is theft. The cap is your exposure.
- **Single-writer lock.** Two tabs spending the same proofs is the small problem; two tabs
  overwriting each other's saved state loses ecash outright. Web Locks where available.
- **Pending payments are never discarded.** A token handed to a relay with no answer is kept and
  later checked against the mint (NUT-07); unspent ones return to the balance. If the mint can't
  be reached we hold, rather than guess.

## Sweeping back

Melting needs an invoice for a fixed amount, but the routing fee isn't known until the mint
quotes it — so "how much should I ask for?" has no good answer with a bare invoice. Give a
**lightning address** and the library picks the amount and converges on it, returning unused fee
reserve (NUT-08) to the float. `estimateRefund()` reports the number without melting.

A bare node pubkey can't work: melt has no keysend.

Design notes: https://github.com/tajava2006/nostr-paywall

> Proof of concept.

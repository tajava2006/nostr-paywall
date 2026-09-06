# nostr-paywall

Pay-per-event paid relaying for nostr. **One event, one sat** — not a subscription.

## Why not subscriptions

A per-account subscription cannot express what's actually needed:

1. **Multiple identities.** People run separate keys per context; a subscription is bound to one.
2. **Throwaway keys.** NIP-17 DMs are signed by a fresh key every time. There is nothing to subscribe.
3. **Small amounts.** The honest price is a fraction of a cent, not a monthly minimum.

All three need a **bearer** payment, so payment happens per event.

## What costs money

Reading is free. Publishing a plain note is free — nobody reads a global feed, so an untagged
note reaches no one and can't be spam. What costs a sat is an event that **puts itself in front
of someone**: a reply, mention, repost, reaction, or DM.

```
charged = kind ∈ {1, 4, 6, 7, 16, 1111, 1059}  AND  (has an "e" or "p" tag)
```

An allowlist, not an exception list: unknown kinds are free, which fails open. Follow lists
(kind 3), relay lists and sets carry structural `p` tags and drop out automatically.

**Honest limits.** Charging writes buys *spam resistance*, not infrastructure — a relay's real
cost is read bandwidth, and reading stays free. What it does buy: bounded storage growth and no
need for LLM/WoT filtering.

## How a payment travels

```
["EVENT", <event>, <payment>]
```

A third element on the standard EVENT message, sent **only to relays known to accept it**;
everyone else gets the normal two-element form, so nothing in the ecosystem breaks. Keeping the
payment in the same message makes it structurally bound to the event — no pending state, no TTL,
no orphaned payments.

Terms are advertised in the relay's NIP-11 document (`fees.publication` + `payment_v1`) and
fetched lazily, **after** a `payment-required:` response. Nobody reads NIP-11 proactively, but
everybody can read it once they've been told to pay.

## Packages

| | |
|---|---|
| [`@nostr-paywall/protocol`](packages/protocol) | Charging predicate, NIP-11 parsing, envelope, OK conventions. Zero dependencies. Shared by relay and client so the rule can't drift. |
| [`@nostr-paywall/collectors`](packages/collectors) | Cashu collection, plus the mint-fee boot gate. |
| [`@nostr-paywall/relay-guard`](packages/relay-guard) | Payment ledger (`node:sqlite`) and the guard. Hook-agnostic. |
| [`@nostr-paywall/client`](packages/client) | `PaidPool` — a drop-in `SimplePool` replacement that attaches payment. |
| [`@nostr-paywall/float`](packages/float) | Client-side ecash float: top up once over NWC, spend a sat at a time, sweep back. |
| [`apps/demo`](apps/demo) | A strict outbox-model client that demonstrates the result. |

The relay itself is not here — it's a fork of
[nostr-relay-nestjs](https://github.com/CodyTseng/nostr-relay-nestjs) on its `paywall` branch.

## Client integration

One line, plus wiring your existing wallet:

```ts
const pool = new PaidPool({
  payer: createFloatPayer(float),   // or bring your own
});
// everything else is SimplePool
```

Payment failures reject with `PaymentUnavailableError`. **Surface it distinctly** — a paid relay
is usually the recipient's inbox relay, so blurring it into a generic error means "the UI said
sent, the recipient never got it".

## Relay operator

```sh
PAYWALL_ENABLED=true
PAYWALL_MINTS=https://mint.minibits.cash/Bitcoin   # must have input_fee_ppk == 0
PAYWALL_LEDGER_PATH=/var/lib/relay/paywall.db      # asset store, not a cache — back it up
PAYWALL_PRICE_MSAT=1000
```

Off by default. Two things bite operators:

- **The mint must charge no swap fee.** With `input_fee_ppk = 100`, a 1 sat payment leaves 0 sat
  after fees and cannot clear at all. The relay checks this at boot and refuses to start otherwise.
- **The ledger file is the only copy of collected ecash.** It's bearer money. Back it up.

## Status

Proof of concept, unaudited, running on mainnet with real (tiny) amounts. The design record —
including the reversals and everything measured the hard way — is in [PLAN.md](PLAN.md).

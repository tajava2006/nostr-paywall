# @nostr-paywall/protocol

The pure protocol layer for pay-per-event nostr relaying. Zero runtime dependencies.

Relay and client run **the same code**. Two copies of the rule always drift — you get
"the client thought it was free, the relay charged" and nobody notices for a week.

```ts
import { priceFor, parsePaymentTerms, takePaymentEnvelope, parseOkReason } from '@nostr-paywall/protocol';

// Read the terms a relay advertises (lazily, after it tells you to pay)
const terms = parsePaymentTerms(await fetchRelayInformation(url));

// Would this relay charge for this event?
const price = priceFor(event, terms);   // { charge: true, amountMsat: 1000, rule } | { charge: false }
```

- **Charging predicate** — the policy lives in the relay's advertised `terms`, not in this code.
  The client evaluates *the relay's* rule, which is what makes single-round-trip publishing possible.
- **NIP-11 parser** — untrusted remote JSON, so it never throws. Anything it can't read is free.
- **Envelope** — assembling and splitting `["EVENT", <event>, <payment>]`.
- **OK conventions** — building (relay) and parsing (client) live in one file so the prefixes
  can't diverge.

Design notes: https://github.com/tajava2006/nostr-paywall

> Proof of concept.

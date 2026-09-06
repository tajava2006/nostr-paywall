# @nostr-paywall/collectors

Payment collection for a paid nostr relay. The only layer that touches money.

```ts
import { CashuCollector, assertZeroFeeMints } from '@nostr-paywall/collectors';

const collector = new CashuCollector({ allowedMints: ['https://mint.example'] });
await collector.init();                              // boot gate, see below

const v = await collector.validate(envelope, ctx);   // touches nothing
if (v.ok) await collector.collect(envelope, ctx);    // money moves only here
```

Splitting `validate` from `collect` is the point: every non-payment rejection reason is checked
before anything is collected, and the type system enforces the order.

## The mint must have `input_fee_ppk == 0`

Under NUT-02, `fees = ceil(sum(input_fee_ppk) / 1000)` and `sum(inputs) - fees == sum(outputs)`.
At `ppk = 100` the fee for one input is 1 sat, so a 1 sat payment leaves **zero** outputs and the
swap cannot be constructed at all. Measured, not theorised.

`init()` checks this and throws. Failing to boot is correct — the alternative is a relay that
takes users' money and never collects it, with nothing in the logs.

Design notes: https://github.com/tajava2006/nostr-paywall

> Proof of concept.

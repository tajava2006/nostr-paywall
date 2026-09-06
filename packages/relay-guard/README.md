# @nostr-paywall/relay-guard

Payment ledger and guard for a paid nostr relay. Uses `node:sqlite`, so no native dependencies.

> **Requires Node 22.5+** (when `node:sqlite` landed); **24+ recommended**, below that it needs
> `--experimental-sqlite`. On an older runtime the relay dies at boot with
> `ERR_UNKNOWN_BUILTIN_MODULE: No such built-in module: node:sqlite`.
> If you run under pm2 or systemd, check **the daemon's** Node version — switching versions in
> your shell doesn't change what the daemon hands its children.

```ts
import { PaymentGuard, SqlitePaymentRepository } from '@nostr-paywall/relay-guard';

const guard = new PaymentGuard({ terms, collectors: [collector], repository: new SqlitePaymentRepository(path) });
await guard.init();

const outcome = await guard.check(event, envelope);
// 'free' | 'already-paid' | 'collected' | 'reject' (put okMessage straight into the OK)
```

**Hook-agnostic** — it imports no relay implementation, so it drops onto any of them.

## What the ledger guarantees

1. **No double spend.** A proof secret buys exactly one event; that's the primary key.
2. **Idempotency, in the user's favour.** Sending the same event twice never charges twice —
   including when the client lost the envelope and retries with fresh proofs.
3. **Custody.** Collected proofs are bearer money and this ledger is the **only copy**. It's an
   asset ledger, not an audit log, which is why it's kept independent of the relay's event store.

The database check is a fast path, not the final arbiter — the mint's swap is. Two concurrent
requests may both pass here; one dies at the mint. The ledger exists to avoid wasted work and to
get idempotency exactly right.

Design notes: https://github.com/tajava2006/nostr-paywall

> Proof of concept.

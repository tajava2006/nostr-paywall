// The argument. This is why the demo exists.

export const ABOUT_HTML = `
<div class="card">
  <h2 style="margin:0 0 10px;font-size:17px">Spam is a routing problem, not a filtering problem</h2>

  <p>
    Nostr has two chronic problems, and they share a root. Accounts are free, so spam is free.
    And relays run on operator goodwill, so nobody is paid to fight it. The usual answers —
    LLM filters, web-of-trust — burn <em>more</em> operator resources to solve a problem caused by
    there being no resources. They also put someone in charge of deciding what you may say.
  </p>

  <p>
    Paid relays fix both at once, but subscriptions can't express what's actually needed.
    You can't charge a per-account subscription when people run several identities, when
    NIP-17 DMs are signed by a fresh throwaway key every time, or when the honest price is
    a fraction of a cent. All three need a <b>bearer</b> payment. So: <b>one event, one sat.</b>
  </p>

  <h3 style="font-size:14px;margin:18px 0 6px">Only attention costs money</h3>
  <p>
    Reading is free. Publishing a plain note is free — nobody reads a global feed, so an
    untagged note reaches no one and cannot be spam. What costs a sat is an event that
    <b>puts itself in front of someone</b>: a reply, a mention, a repost, a reaction, a DM.
    The fee is a toll on attention, and attention belongs to the person being tagged.
  </p>

  <h3 style="font-size:14px;margin:18px 0 6px">Why the outbox model is the whole trick</h3>
  <p>
    NIP-65 says: to find what someone <b>wrote</b>, read their <b>write</b> relays; to find what
    was sent <b>to</b> them, read their <b>read</b> (inbox) relays. That second rule is the one
    that matters here.
  </p>
  <p>
    The account in this demo lists exactly one inbox relay, and that relay charges. So when a
    client looks for replies the correct way — <b>in the author's inbox</b> — every reply it finds
    was paid for. Not "filtered". <b>Structurally unable to be free.</b>
  </p>
  <p class="dim">
    Right now, elsewhere on the network, this account has spam replies. Another client notifies
    about them. This one doesn't show them — not because we filter, but because we never look
    anywhere the author didn't ask to be reached.
  </p>

  <h3 style="font-size:14px;margin:18px 0 6px">You only need one query, if everyone follows the spec</h3>
  <p>
    A natural worry: a reply to a reply might be published somewhere else, so wouldn't you have
    to walk each commenter's inbox recursively? No — and it matters that the answer is no.
    NIP-10 says a reply carries <b>all of its parent's <code>p</code> tags</b> plus the parent's
    author. So a reply at any depth still tags the root author, and a spec-following client
    still delivers it to the root author's inbox. One query on one relay returns the whole thread.
  </p>
  <p>
    We deliberately do <b>not</b> crawl recursively to catch non-compliant clients. Doing so
    explodes complexity, and worse, it teaches everyone that "just blast it at a big relay and
    it gets found anyway." That ends with a handful of large relays holding everything, and with
    the clients that <em>do</em> follow the spec being blamed for finding less. We'd rather find
    less and stay correct.
  </p>

  <h3 style="font-size:14px;margin:18px 0 6px">Finding less is a feature</h3>
  <p>
    If a reply doesn't reach you because it was never sent where you said to reach you, that isn't
    a bug — that is the recipient's stated preference being honored. In the same spirit, some
    clients let you drop ancestor <code>p</code> tags when replying deep in a thread. Read that
    literally: <em>notify my direct parent, not everyone above.</em> That's a legitimate choice,
    and a client should respect it rather than route around it.
  </p>

  <h3 style="font-size:14px;margin:18px 0 6px">What this demo is not</h3>
  <p>
    A proof of concept. Unaudited. The price here is symbolic — 1 sat is a mechanism, not a
    deterrent. And paid writes buy <b>spam resistance</b>, not infrastructure: a relay's real
    cost is read bandwidth, and reading stays free. We're not claiming otherwise.
  </p>
</div>`;

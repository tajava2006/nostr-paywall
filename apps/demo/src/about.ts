// The argument, kept short enough that someone might actually read it.

export const ABOUT_HTML = `
<div class="card">
  <h2 style="margin:0 0 12px;font-size:17px">Spam is a routing problem</h2>

  <p>
    Accounts are free, so spam is free. Relays run on goodwill, so nobody is paid to fight it.
    Filtering — LLMs, web-of-trust — spends more of the resource that was missing in the first
    place, and puts someone in charge of what you may say.
  </p>
  <p>
    Charging fixes both, but a subscription can't express it: people run several identities,
    NIP-17 DMs are signed by a fresh key every time, and the honest price is a fraction of a
    cent. All three need a <b>bearer</b> payment. Hence: <b>one event, one sat.</b>
  </p>

  <h3 style="font-size:14px;margin:20px 0 6px">Only attention costs money</h3>
  <p>
    Reading is free, and so is a plain note — nobody reads a global feed, so an untagged note
    reaches no one and can't be spam. A sat is charged when an event <b>puts itself in front of
    someone</b>: a reply, mention, repost, reaction, DM. The toll is on attention, and attention
    belongs to whoever is being tagged.
  </p>

  <h3 style="font-size:14px;margin:20px 0 6px">The outbox model does the rest</h3>
  <p>
    NIP-65: to find what someone <b>wrote</b>, read their <b>write</b> relays; to find what was
    sent <b>to</b> them, read their <b>inbox</b> relays. This account lists one inbox relay, and
    it charges. So every reply below was paid for — not filtered, but
    <b>structurally unable to be free</b>.
  </p>
  <p class="dim">
    This same account has spam replies elsewhere on the network right now, and other clients
    notify about them. This one doesn't show them: we never look anywhere the author didn't ask
    to be reached.
  </p>

  <h3 style="font-size:14px;margin:20px 0 6px">One query is enough</h3>
  <p>
    You might expect to crawl each commenter's inbox recursively. You don't need to: NIP-10 says
    a reply carries <b>all of its parent's <code>p</code> tags</b>, so a reply at any depth still
    tags the root author and still lands in their inbox. One query returns the whole thread.
  </p>
  <p>
    We deliberately don't crawl to catch clients that ignore this. That teaches everyone to
    "just blast it at a big relay" — which ends in a few relays holding everything, and in the
    clients that follow the spec being blamed for finding less.
  </p>

  <h3 style="font-size:14px;margin:20px 0 6px">Finding less is the feature</h3>
  <p>
    A reply sent somewhere you never asked to be reached, not reaching you, is your preference
    being honored. Answer a comment here and it goes to the read relays of everyone it tags,
    which for a real user may be a free relay. It then reaches the <b>reply author's own
    notifications</b> — but not the root author, and not this thread. Three outcomes, each one
    what the person concerned asked for.
  </p>

  <h3 style="font-size:14px;margin:20px 0 6px">No account, by the same rule</h3>
  <p>
    If payment is the only thing that measures spam, an account system measures nothing — so
    there is no login here. Replying generates a throwaway key in this browser; clear storage
    and you are someone else. That is the entire identity layer.
  </p>
  <p>
    Which leaves paying. Connect any NWC wallet and you are done: it buys ecash once, and a sat
    is spent per event from there. That is the only thing a client has to add.
  </p>

  <p class="dim small" style="margin-top:20px">
    Proof of concept, unaudited. 1 sat is a mechanism, not a deterrent. And paid writes buy spam
    resistance, not infrastructure — a relay's real cost is read bandwidth, which stays free.
  </p>
</div>`;

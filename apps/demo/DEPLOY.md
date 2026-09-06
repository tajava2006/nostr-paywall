# Deploying the demo to nsite

The demo is static, so it hosts fine as an [nsite](https://nsyte.run) (NIP-5A): files go to
blossom servers, and a kind `15128` manifest maps each path to its sha256.

**ngit is unrelated.** That publishes a git repository over nostr; nsite publishes a website.
The manifest's `source` tag is optional and may point at GitHub.

## One-time setup

`nsite-cli` only accepts an nsec, so use **nsyte** — it speaks NIP-46, which is what you want
if the signing key is your main identity.

```sh
deno install -A -f -g -n nsyte jsr:@nsyte/cli     # or a release binary
nsyte bunker connect                              # interactive; or pass a bunker:// URL
```

The bunker pubkey lands in `.nsite/config.json`, so it is safe to commit — the key itself never
leaves your signer.

## Deploy

```sh
pnpm -F @nostr-paywall/demo deploy
```

That builds and uploads `dist/`. The site is then served at `<pubkeyB36>.<gateway>`.

## Notes

- `fallback: /index.html` matters: the demo is a single page, and without it a deep link 404s.
- Every outbound request the demo makes (mint, relay NIP-11, LNURL) is cross-origin, so those
  hosts must send CORS headers. All three currently do.
- `publishProfile` is off. Deploying should not overwrite the signing key's kind 0.

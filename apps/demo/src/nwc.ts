// A minimal NWC (NIP-47) client.
//
// **This belongs to the app.** Handing the connection string to a library would give it the
// app's entire budget and force it to reimplement this. The app uses it to build just
// `payInvoice` and `makeInvoice`, and passes those two functions down.
//
// nostr-tools' `nip47` only offers `parseConnectionString` and request assembly — there is
// **no response waiting or correlation**. That loop is what lives here.

import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { Relay } from 'nostr-tools/relay';
import { nip04, nip44 } from 'nostr-tools';
import { hexToBytes } from 'nostr-tools/utils';

export interface NwcConnection {
  walletPubkey: string;
  relays: string[];
  secret: Uint8Array;
}

/**
 * `nostr+walletconnect://<walletPubkey>?relay=...&secret=...`
 *
 * `nostrwalletconnect://` is accepted too: NIP-47 specifies the `+` form, but wallets in the
 * wild still emit the older one and a scanned QR is whatever the wallet decided to draw.
 */
export function parseNwcUri(uri: string): NwcConnection {
  const url = new URL(uri.trim().replace(/^nostr\+?walletconnect:\/\//i, 'https://'));
  const walletPubkey = url.hostname || url.pathname.replace(/\//g, '');
  const relays = url.searchParams.getAll('relay');
  const secret = url.searchParams.get('secret');
  if (!walletPubkey || relays.length === 0 || !secret) {
    throw new Error('an NWC connection string needs pubkey, relay and secret');
  }
  return { walletPubkey, relays, secret: hexToBytes(secret) };
}

type Encryption = 'nip44_v2' | 'nip04';

function encrypt(conn: NwcConnection, scheme: Encryption, plaintext: string): string {
  if (scheme === 'nip04') return nip04.encrypt(conn.secret, conn.walletPubkey, plaintext);
  return nip44.v2.encrypt(plaintext, nip44.v2.utils.getConversationKey(conn.secret, conn.walletPubkey));
}

function decrypt(conn: NwcConnection, scheme: Encryption, ciphertext: string): string {
  if (scheme === 'nip04') return nip04.decrypt(conn.secret, conn.walletPubkey, ciphertext);
  return nip44.v2.decrypt(ciphertext, nip44.v2.utils.getConversationKey(conn.secret, conn.walletPubkey));
}

export class NwcClient {
  private readonly conn: NwcConnection;
  /** The encryption the wallet advertises. No info event means NIP-04, per NIP-47. */
  private scheme: Encryption | undefined;

  constructor(uri: string) {
    this.conn = parseNwcUri(uri);
  }

  private async relay(): Promise<Relay> {
    return Relay.connect(this.conn.relays[0]!);
  }

  /** Read supported encryption from the kind 13194 info event. */
  private async negotiate(relay: Relay): Promise<Encryption> {
    if (this.scheme) return this.scheme;
    const info = await new Promise<{ tags: string[][] } | null>((resolve) => {
      const timer = setTimeout(() => {
        sub.close();
        resolve(null);
      }, 5000);
      const sub = relay.subscribe([{ kinds: [13194], authors: [this.conn.walletPubkey], limit: 1 }], {
        onevent: (e) => {
          clearTimeout(timer);
          sub.close();
          resolve(e);
        },
        oneose: () => {
          clearTimeout(timer);
          sub.close();
          resolve(null);
        },
      });
    });
    const advertised = info?.tags.find((t) => t[0] === 'encryption')?.[1] ?? '';
    // No info event, or no encryption tag, means NIP-04 (stated in NIP-47)
    this.scheme = advertised.includes('nip44_v2') ? 'nip44_v2' : 'nip04';
    return this.scheme;
  }

  /** Send a request and wait for the matching 23195 response. */
  async request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const relay = await this.relay();
    try {
      const scheme = await this.negotiate(relay);
      const content = encrypt(this.conn, scheme, JSON.stringify({ method, params }));
      const req = finalizeEvent(
        {
          kind: 23194,
          created_at: Math.floor(Date.now() / 1000),
          content,
          tags: [
            ['p', this.conn.walletPubkey],
            ...(scheme === 'nip44_v2' ? [['encryption', 'nip44_v2']] : []),
          ],
        },
        this.conn.secret,
      );

      const me = getPublicKey(this.conn.secret);
      const answer = new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          sub.close();
          reject(new Error(`${method} timed out — check the wallet is connected to this relay`));
        }, 60_000);
        const sub = relay.subscribe(
          [{ kinds: [23195], authors: [this.conn.walletPubkey], '#p': [me], '#e': [req.id] }],
          {
            onevent: (e) => {
              clearTimeout(timer);
              sub.close();
              try {
                const body = JSON.parse(decrypt(this.conn, scheme, e.content)) as {
                  result?: T;
                  error?: { code: string; message: string };
                };
                if (body.error) reject(new Error(`${body.error.code}: ${body.error.message}`));
                else resolve(body.result as T);
              } catch (err) {
                reject(err as Error);
              }
            },
          },
        );
      });

      await relay.publish(req);
      return await answer;
    } finally {
      relay.close();
    }
  }

  payInvoice(invoice: string): Promise<{ preimage: string }> {
    return this.request('pay_invoice', { invoice });
  }

  makeInvoice(amountMsat: number, description: string): Promise<{ invoice: string }> {
    return this.request('make_invoice', { amount: amountMsat, description });
  }

  getBalance(): Promise<{ balance: number }> {
    return this.request('get_balance', {});
  }
}

// 최소 NWC(NIP-47) 클라이언트.
//
// **앱이 갖는 게 맞다.** 라이브러리에 연결 문자열을 넘기면 앱 전체 예산을 통째로
// 상속시키는 꼴이고, 라이브러리가 NWC 클라를 재구현하게 된다. 앱은 이걸로
// `payInvoice`/`makeInvoice` 두 함수만 만들어 라이브러리에 물려준다.
//
// nostr-tools 의 `nip47` 은 `parseConnectionString` 과 요청 이벤트 조립만 제공하고
// **응답 대기·상관관계는 없다** — 그 루프가 여기 있다.

import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { Relay } from 'nostr-tools/relay';
import { nip04, nip44 } from 'nostr-tools';
import { hexToBytes } from 'nostr-tools/utils';

export interface NwcConnection {
  walletPubkey: string;
  relays: string[];
  secret: Uint8Array;
}

/** `nostr+walletconnect://<walletPubkey>?relay=...&secret=...` */
export function parseNwcUri(uri: string): NwcConnection {
  const url = new URL(uri.replace(/^nostr\+walletconnect:\/\//, 'https://'));
  const walletPubkey = url.hostname || url.pathname.replace(/\//g, '');
  const relays = url.searchParams.getAll('relay');
  const secret = url.searchParams.get('secret');
  if (!walletPubkey || relays.length === 0 || !secret) {
    throw new Error('NWC 연결 문자열에 pubkey/relay/secret 이 모두 있어야 한다');
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
  /** 지갑이 광고한 암호화 방식. info 이벤트가 없으면 NIP-04 로 가정한다(NIP-47 하위호환 규정). */
  private scheme: Encryption | undefined;

  constructor(uri: string) {
    this.conn = parseNwcUri(uri);
  }

  private async relay(): Promise<Relay> {
    return Relay.connect(this.conn.relays[0]!);
  }

  /** kind 13194 info 이벤트에서 지원 암호화를 읽는다. */
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
    // info 가 없거나 encryption 태그가 없으면 NIP-04 (NIP-47 명시)
    this.scheme = advertised.includes('nip44_v2') ? 'nip44_v2' : 'nip04';
    return this.scheme;
  }

  /** 요청을 보내고 대응하는 23195 응답을 기다린다. */
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
          reject(new Error(`${method} 응답 시간 초과 — 지갑이 이 릴레이에 붙어 있는지 확인할 것`));
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

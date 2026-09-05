// 라이트닝 주소 환불 (LUD-16 + LUD-06).
//
// **왜 필요한가**: NUT-05 melt 는 금액이 박힌 bolt11 을 요구하는데, 얼마짜리
// 인보이스를 만들어야 하는지는 **melt quote 를 받아봐야 안다**(수수료 예약분이
// 금액에 따라 달라지므로). 유저에게 "얼마짜리 인보이스를 주세요"라고 물으면
// 유저도 답을 모른다 — 라이트닝 지갑에서 늘 겪는 그 문제다.
//
// 라이트닝 주소면 **우리가 금액을 정해 인보이스를 뽑을 수 있어서** 반복으로 수렴시킬 수 있다.

export interface LnurlPayParams {
  callback: string;
  minSendableMsat: number;
  maxSendableMsat: number;
}

/** `user@domain` → LUD-16 엔드포인트. onion 은 http, 그 외 https. */
export function lightningAddressToUrl(address: string): string {
  const at = address.lastIndexOf('@');
  if (at <= 0) throw new Error(`라이트닝 주소가 아니다: ${address}`);
  const user = address.slice(0, at);
  const domain = address.slice(at + 1);
  if (!/^[a-z0-9-_.+]+$/.test(user)) {
    throw new Error(`LUD-16 은 소문자·숫자·-_.+ 만 허용한다: ${user}`);
  }
  const scheme = domain.endsWith('.onion') ? 'http' : 'https';
  return `${scheme}://${domain}/.well-known/lnurlp/${user}`;
}

type FetchLike = (url: string) => Promise<{
  ok?: boolean;
  status?: number;
  json(): Promise<unknown>;
  text?(): Promise<string>;
}>;

/**
 * JSON 을 기대하고 읽되, 아니면 **무슨 일이 났는지 알려준다.**
 *
 * 그냥 `res.json()` 을 부르면 서버가 죽었을 때 `Unexpected token '<'` 만 나와서
 * 원인을 못 찾는다 — 실제로 겪었다(라이트닝 주소 서버가 502 를 반환).
 */
async function readJson(res: Awaited<ReturnType<FetchLike>>, what: string): Promise<unknown> {
  if (res.ok === false) {
    const body = (await res.text?.())?.slice(0, 200) ?? '';
    throw new Error(
      `${what} 응답이 HTTP ${res.status} 다. 라이트닝 주소 서버가 살아 있는지 확인할 것.` +
        (body ? ` 본문: ${body.replace(/\s+/g, ' ').trim()}` : ''),
    );
  }
  try {
    return await res.json();
  } catch {
    throw new Error(`${what} 응답이 JSON 이 아니다 — 엔드포인트가 LNURL 을 서빙하지 않는다`);
  }
}

export async function resolveLightningAddress(
  address: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<LnurlPayParams> {
  const url = lightningAddressToUrl(address);
  const res = await fetchImpl(url);
  const body = (await readJson(res, `LNURL(${url})`)) as Record<string, unknown>;
  if (body['tag'] !== 'payRequest') {
    throw new Error(`payRequest 가 아니다: ${JSON.stringify(body['reason'] ?? body['tag'])}`);
  }
  const callback = body['callback'];
  const min = body['minSendable'];
  const max = body['maxSendable'];
  if (typeof callback !== 'string' || typeof min !== 'number' || typeof max !== 'number') {
    throw new Error('payRequest 응답에 callback/minSendable/maxSendable 이 없다');
  }
  return { callback, minSendableMsat: min, maxSendableMsat: max };
}

/** 정해진 금액으로 인보이스를 받는다. */
export async function requestInvoice(
  params: LnurlPayParams,
  amountSats: number,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<string> {
  const msat = amountSats * 1000;
  if (msat < params.minSendableMsat || msat > params.maxSendableMsat) {
    throw new Error(
      `${amountSats} sat 는 허용 범위 밖이다 ` +
        `(${params.minSendableMsat / 1000}~${params.maxSendableMsat / 1000} sat)`,
    );
  }
  const sep = params.callback.includes('?') ? '&' : '?';
  const res = await fetchImpl(`${params.callback}${sep}amount=${msat}`);
  const body = (await readJson(res, 'LNURL 인보이스 발급')) as Record<string, unknown>;
  const pr = body['pr'];
  if (typeof pr !== 'string' || pr.length === 0) {
    throw new Error(`인보이스를 못 받았다: ${JSON.stringify(body['reason'] ?? body)}`);
  }
  return pr;
}

/**
 * 예산 안에 들어오는 최대 송금액을 찾는다.
 *
 * `quoteFor(sats)` 는 그 금액으로 인보이스를 뽑아 melt 견적을 받고
 * `필요액 = amount + fee_reserve` 를 돌려준다. 필요액이 예산을 넘으면 **초과분만큼
 * 깎아서** 다시 시도한다 — 수수료가 금액에 비례하므로 보통 2~3회에 수렴한다.
 *
 * 못 찾으면 `null`(잔액이 수수료도 못 감당).
 */
export async function findAffordableAmount(
  budgetSats: number,
  quoteFor: (sats: number) => Promise<{ neededSats: number; quote: unknown }>,
  maxAttempts = 5,
): Promise<{ sendSats: number; neededSats: number; quote: unknown } | null> {
  let attempt = budgetSats;
  for (let i = 0; i < maxAttempts && attempt > 0; i++) {
    const { neededSats, quote } = await quoteFor(attempt);
    if (neededSats <= budgetSats) return { sendSats: attempt, neededSats, quote };
    // 초과분을 깎는다. 최소 1 sat 은 줄여야 무한 루프가 안 된다.
    attempt -= Math.max(1, neededSats - budgetSats);
  }
  return null;
}

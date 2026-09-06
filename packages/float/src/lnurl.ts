// Sweeping to a lightning address (LUD-16 + LUD-06).
//
// **Why this exists**: NUT-05 melt needs an invoice for a fixed amount, but how large that
// invoice should be is only known **after** a melt quote, because the fee reserve depends on
// the amount. Asking the user "what amount?" is asking a question they cannot answer — the
// familiar annoyance of every lightning wallet.
//
// With a lightning address **we choose the amount and mint the invoice**, so it converges.

export interface LnurlPayParams {
  callback: string;
  minSendableMsat: number;
  maxSendableMsat: number;
}

/** `user@domain` → the LUD-16 endpoint. http for onion, https otherwise. */
export function lightningAddressToUrl(address: string): string {
  const at = address.lastIndexOf('@');
  if (at <= 0) throw new Error(`not a lightning address: ${address}`);
  const user = address.slice(0, at);
  const domain = address.slice(at + 1);
  if (!/^[a-z0-9-_.+]+$/.test(user)) {
    throw new Error(`LUD-16 allows only lowercase, digits and -_.+ : ${user}`);
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
 * Read JSON, but when it is not JSON, **say what actually happened**.
 *
 * A bare `res.json()` on a dead server yields only `Unexpected token '<'`, which hides the
 * cause — as it did here when the lightning address server returned 502.
 */
async function readJson(res: Awaited<ReturnType<FetchLike>>, what: string): Promise<unknown> {
  if (res.ok === false) {
    const body = (await res.text?.())?.slice(0, 200) ?? '';
    throw new Error(
      `${what} returned HTTP ${res.status}. Check that the lightning address server is up.` +
        (body ? ` Body: ${body.replace(/\s+/g, ' ').trim()}` : ''),
    );
  }
  try {
    return await res.json();
  } catch {
    throw new Error(`${what} did not return JSON — that endpoint is not serving LNURL`);
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
    throw new Error(`not a payRequest: ${JSON.stringify(body['reason'] ?? body['tag'])}`);
  }
  const callback = body['callback'];
  const min = body['minSendable'];
  const max = body['maxSendable'];
  if (typeof callback !== 'string' || typeof min !== 'number' || typeof max !== 'number') {
    throw new Error('payRequest response is missing callback/minSendable/maxSendable');
  }
  return { callback, minSendableMsat: min, maxSendableMsat: max };
}

/** Request an invoice for a chosen amount. */
export async function requestInvoice(
  params: LnurlPayParams,
  amountSats: number,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<string> {
  const msat = amountSats * 1000;
  if (msat < params.minSendableMsat || msat > params.maxSendableMsat) {
    throw new Error(
      `${amountSats} sat is outside the allowed range ` +
        `(${params.minSendableMsat / 1000}~${params.maxSendableMsat / 1000} sat)`,
    );
  }
  const sep = params.callback.includes('?') ? '&' : '?';
  const res = await fetchImpl(`${params.callback}${sep}amount=${msat}`);
  const body = (await readJson(res, 'LNURL invoice request')) as Record<string, unknown>;
  const pr = body['pr'];
  if (typeof pr !== 'string' || pr.length === 0) {
    throw new Error(`no invoice returned: ${JSON.stringify(body['reason'] ?? body)}`);
  }
  return pr;
}

/**
 * Find the largest amount that fits the budget.
 *
 * `quoteFor(sats)` mints an invoice for that amount, takes a melt quote and reports
 * `amount + fee_reserve`. If that exceeds the budget, **trim by the overshoot** and retry;
 * since the fee scales with the amount this usually converges in two or three rounds.
 *
 * `null` when even the fee cannot be covered.
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
    // Trim by the overshoot; at least 1 sat, or this loops forever.
    attempt -= Math.max(1, neededSats - budgetSats);
  }
  return null;
}

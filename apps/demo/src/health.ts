// Liveness checks for the two services this demo depends on.
//
// A demo that silently fails because a mint is down is worse than useless — you'd
// blame the protocol. Make the dependency visible.

export type Health =
  | { state: 'checking' }
  | { state: 'up'; detail: string; ms: number }
  | { state: 'down'; detail: string };

/** Relay liveness via its NIP-11 document (same URL as the websocket). */
export async function checkRelay(wsUrl: string): Promise<Health> {
  const httpUrl = wsUrl.replace(/^wss:\/\//, 'https://').replace(/^ws:\/\//, 'http://');
  const t0 = performance.now();
  try {
    const res = await fetch(httpUrl, { headers: { Accept: 'application/nostr+json' } });
    if (!res.ok) return { state: 'down', detail: `HTTP ${res.status}` };
    const info = (await res.json()) as {
      name?: string;
      limitation?: { payment_required?: boolean };
      fees?: { publication?: { amount?: number; unit?: string }[] };
    };
    const rule = info.fees?.publication?.[0];
    const price =
      rule?.amount !== undefined
        ? `${rule.unit === 'msats' ? rule.amount / 1000 : rule.amount} sat/event`
        : 'free';
    return {
      state: 'up',
      detail: `${info.name ?? 'relay'} · ${info.limitation?.payment_required ? price : 'free'}`,
      ms: Math.round(performance.now() - t0),
    };
  } catch (e) {
    return { state: 'down', detail: (e as Error).message };
  }
}

/**
 * Mint liveness, and the one policy detail that decides whether 1 sat is even possible:
 * NUT-02 `input_fee_ppk`. With a non-zero swap fee a 1 sat payment can't clear.
 */
export async function checkMint(mintUrl: string): Promise<Health> {
  const t0 = performance.now();
  try {
    const [infoRes, keysetsRes] = await Promise.all([
      fetch(`${mintUrl}/v1/info`),
      fetch(`${mintUrl}/v1/keysets`),
    ]);
    if (!infoRes.ok) return { state: 'down', detail: `HTTP ${infoRes.status}` };
    const info = (await infoRes.json()) as { name?: string };
    const keysets = (await keysetsRes.json()) as {
      keysets?: { unit: string; active: boolean; input_fee_ppk?: number }[];
    };
    const active = (keysets.keysets ?? []).filter((k) => k.active && k.unit === 'sat');
    const ppk = active.length ? Math.max(...active.map((k) => k.input_fee_ppk ?? 0)) : null;
    const feeNote = ppk === 0 ? 'fee 0' : ppk === null ? 'no sat keyset' : `fee ${ppk} ppk ⚠`;
    return {
      state: 'up',
      detail: `${info.name ?? 'mint'} · ${feeNote}`,
      ms: Math.round(performance.now() - t0),
    };
  } catch (e) {
    return { state: 'down', detail: (e as Error).message };
  }
}

// Mint fee policy — **whether a 1 sat price is possible at all** (PLAN D13 / §4.1 H1b).
//
// NUT-02: `fees = ceil(sum(input_fee_ppk) / 1000)`, and `sum(inputs) - fees == sum(outputs)`.
// At ppk=100 the fee for 1..10 inputs is 1 sat, so a 1 sat proof yields zero outputs and the
// **swap cannot be constructed** (measured: `Inputs: 0, Outputs: 0`).
//
// This is the kind of thing that fails silently: one wrong mint in the config and every
// collection fails or nets zero, with nothing throwing anywhere. So it becomes a boot gate.

export interface KeysetLike {
  id: string;
  unit: string;
  active: boolean;
  input_fee_ppk?: number;
}

/** The NUT-02 fee formula: sum ppk over inputs, then divide by 1000 rounding up. */
export function feeForInputs(inputCount: number, inputFeePpk: number): number {
  if (inputCount <= 0) return 0;
  return Math.ceil((inputCount * inputFeePpk) / 1000);
}

/**
 * The largest ppk among **active** keysets for this unit.
 *
 * Worst case, because we don't get to choose which active keyset a client mints from: if any
 * one of them charges, a 1 sat payment arriving that way is dead. No active keyset for the
 * unit returns `null` (undecidable, therefore rejected).
 */
export function maxActiveInputFeePpk(keysets: readonly KeysetLike[], unit = 'sat'): number | null {
  const active = keysets.filter((k) => k.active && k.unit === unit);
  if (active.length === 0) return null;
  return Math.max(...active.map((k) => k.input_fee_ppk ?? 0));
}

export interface MintFeePolicy {
  mint: string;
  ppk: number | null;
  /** Can a 1 sat payment clear at this mint? */
  zeroFee: boolean;
}

export type FetchLike = (url: string) => Promise<{ json(): Promise<unknown> }>;

/** Read the mint's `/v1/keysets` and decide its fee policy. */
export async function fetchMintFeePolicy(
  mint: string,
  unit = 'sat',
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<MintFeePolicy> {
  const res = await fetchImpl(`${mint.replace(/\/+$/, '')}/v1/keysets`);
  const body = (await res.json()) as { keysets?: KeysetLike[] };
  const ppk = maxActiveInputFeePpk(body.keysets ?? [], unit);
  return { mint, ppk, zeroFee: ppk === 0 };
}

/**
 * Boot gate: every allowlisted mint must have ppk == 0, otherwise **throw**.
 *
 * Refusing to start is correct. Starting with this broken means taking users' money while
 * collection quietly fails.
 */
export async function assertZeroFeeMints(
  mints: readonly string[],
  unit = 'sat',
  fetchImpl?: FetchLike,
): Promise<MintFeePolicy[]> {
  if (mints.length === 0) throw new Error('the mint allowlist is empty');
  const policies = await Promise.all(mints.map((m) => fetchMintFeePolicy(m, unit, fetchImpl)));
  const bad = policies.filter((p) => !p.zeroFee);
  if (bad.length > 0) {
    const detail = bad.map((p) => `${p.mint} (input_fee_ppk=${p.ppk ?? 'unknown'})`).join(', ');
    throw new Error(
      `allowlisted mint cannot clear a 1 sat payment: ${detail}. ` +
        `Under NUT-02 the fee meets or exceeds the amount, so the swap cannot be constructed — ` +
        `use mints with input_fee_ppk == 0.`,
    );
  }
  return policies;
}

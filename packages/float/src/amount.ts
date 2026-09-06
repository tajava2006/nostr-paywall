// Normalising proof amounts.
//
// **Why its own file**: cashu-ts v4's `Proof.amount` is an `Amount` class (a bigint wrapper),
// not a number, and it comes back differently depending on the store:
//
//   JSON (file)          → "1"         string → Number() works, by accident
//   structuredClone (IDB) → {value: 1n} object → Number() gives **NaN**
//
// That difference is why the Node drill passed while balances went NaN only in a browser.
// Pin the amount to a plain number at write time and the environments stop diverging.

/** Whatever shape arrives, produce sats. Unreadable input yields `NaN`, deliberately. */
export function amountOf(proof: unknown): number {
  const a = (proof as { amount?: unknown } | null)?.amount;
  if (typeof a === 'number') return a;
  if (typeof a === 'bigint') return Number(a);
  if (typeof a === 'string') return Number(a);
  // Either an `Amount` instance, or its prototype-stripped remains (`{value: 1n}`).
  if (a && typeof a === 'object' && 'value' in a) return Number((a as { value: unknown }).value);
  return Number.NaN;
}

/** Pin `amount` to a number before storing or sending; other fields pass through. */
export function normalizeProof<T>(proof: T): T {
  return { ...(proof as object), amount: amountOf(proof) } as T;
}

export function normalizeProofs<T>(proofs: readonly T[]): T[] {
  return proofs.map(normalizeProof);
}

export function sumSats(proofs: readonly unknown[]): number {
  return proofs.reduce<number>((s, p) => s + amountOf(p), 0);
}

// Single-writer lock (PLAN V9 / §6 C2).
//
// Two tabs spending the same proofs is the small problem — the mint blocks the double spend
// and one publish quietly fails. The real damage is both tabs saving state and **one
// overwriting the other's balance**. So read-modify-write is one critical section.

/** In-process serialisation. Enough for Node, or a single tab. */
class InProcessMutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    // Chain regardless of the previous outcome: one failure must not kill the lock.
    const next = this.tail.then(fn, fn);
    this.tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

export interface FloatLock {
  /** The critical section. Do not nest calls — that deadlocks. */
  run<T>(fn: () => Promise<T>): Promise<T>;
}

const LOCK_NAME = 'nostr-paywall-float';

/**
 * A lock suited to the environment.
 *
 * Browsers and Tauri get cross-tab exclusion via the **Web Locks API**; without it we fall
 * back to in-process serialisation (fine for a single Node process).
 *
 * **Multiple tabs without Web Locks are unprotected.** The mint still prevents double
 * spending, so no money disappears, but a publish can fail.
 */
export function createLock(): FloatLock {
  const webLocks =
    typeof navigator !== 'undefined' &&
    typeof (navigator as Navigator & { locks?: LockManager }).locks?.request === 'function'
      ? (navigator as Navigator & { locks: LockManager }).locks
      : undefined;

  if (!webLocks) return new InProcessMutex();

  // Web Locks is exclusive across tabs only; concurrent calls within one tab still need
  // guarding, so layer the in-process mutex underneath.
  const local = new InProcessMutex();
  return {
    run<T>(fn: () => Promise<T>): Promise<T> {
      return local.run(() => webLocks.request(LOCK_NAME, () => fn()) as Promise<T>);
    },
  };
}

export { InProcessMutex };

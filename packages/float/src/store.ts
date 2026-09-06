// Float persistence.
//
// This is **money**, not a cache: ecash is bearer, so losing it has no recovery path.
// Hence an interface rather than a hardcoded store — with a per-environment default so the
// drop-in story survives (PLAN §6 C1).

import type { Proof } from '@cashu/cashu-ts';

/** Handed to a relay with no definitive answer. **Never discard these.** */
export interface PendingSpend {
  /** The encoded token we sent. A retry must resend it **byte-identical** (PLAN §3.6). */
  token: string;
  /** The underlying proofs. If checkstate says unspent, they come back. */
  proofs: Proof[];
  eventId: string;
  relayUrl: string;
  at: number;
}

export interface MintBucket {
  proofs: Proof[];
  pending: PendingSpend[];
}

export interface FloatState {
  version: 1;
  /** Mint URL → held proofs. Kept per mint, since a token cannot cross mints. */
  mints: Record<string, MintBucket>;
  /** Top-up history: period limits, and something to show the user. */
  topUps: { at: number; sats: number }[];
  /** Spend history — when, which relay, which event. The only record a UI can show. */
  spends?: SpendRecord[];
  /** Refund history. */
  refunds?: RefundRecord[];
}

export interface RefundRecord {
  at: number;
  mint: string;
  /** What actually arrived at the other end. */
  sentSats: number;
  /** Lightning routing fee: the reserve minus whatever change came back. */
  feeSats: number;
  target: string;
}

export interface SpendRecord {
  at: number;
  mint: string;
  sats: number;
  eventId: string;
  relayUrl: string;
}

export function emptyState(): FloatState {
  return { version: 1, mints: {}, topUps: [], spends: [], refunds: [] };
}

export interface FloatStore {
  load(): Promise<FloatState | null>;
  save(state: FloatState): Promise<void>;
}

// ─── memory (tests, throwaway) ──────────────────────────────────

export class MemoryFloatStore implements FloatStore {
  constructor(private state: FloatState | null = null) {}
  async load(): Promise<FloatState | null> {
    return this.state;
  }
  async save(state: FloatState): Promise<void> {
    this.state = structuredClone(state);
  }
}

// ─── file (Node / Bun / Electron main) ──────────────────────────

/**
 * A single JSON file. Nothing to query here, so SQLite would be overkill.
 *
 * Written to a temp file and renamed, so a crash mid-write leaves the original intact —
 * this is money, and a half-written state is not acceptable.
 */
export class FileFloatStore implements FloatStore {
  constructor(private readonly path: string) {}

  async load(): Promise<FloatState | null> {
    const { readFile } = await import('node:fs/promises');
    try {
      return JSON.parse(await readFile(this.path, 'utf8')) as FloatState;
    } catch (e) {
      if ((e as { code?: string }).code === 'ENOENT') return null;
      throw e;
    }
  }

  async save(state: FloatState): Promise<void> {
    const { writeFile, rename, mkdir } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, JSON.stringify(state), 'utf8');
    await rename(tmp, this.path);
  }
}

// ─── IndexedDB (browser / Tauri / Electron renderer) ────────────

const DB_NAME = 'nostr-paywall-float';
const STORE = 'state';
const KEY = 'current';

/**
 * Tauri uses the system webview, so this works there unchanged — no separate adapter.
 *
 * Browser storage is **not durable**: Safari ITP clears script-written storage after 7 days
 * and other browsers evict under pressure. We request `persist()`, but it may be refused.
 * Keeping the float small is the defence that actually holds.
 */
export class IndexedDbFloatStore implements FloatStore {
  private db: Promise<IDBDatabase> | undefined;

  private open(): Promise<IDBDatabase> {
    this.db ??= new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this.db;
  }

  /** Ask not to be evicted. Returns whether it was granted, so the caller can lower the cap. */
  static async requestPersistence(): Promise<boolean> {
    if (typeof navigator === 'undefined' || !navigator.storage?.persist) return false;
    if (await navigator.storage.persisted?.()) return true;
    return navigator.storage.persist();
  }

  async load(): Promise<FloatState | null> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(KEY);
      req.onsuccess = () => resolve((req.result as FloatState | undefined) ?? null);
      req.onerror = () => reject(req.error);
    });
  }

  async save(state: FloatState): Promise<void> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(state, KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
}

/**
 * Pick a store by environment, so an app that configures nothing still works.
 *
 * Node and Bun need a path — where the file goes is the application's business.
 */
export function createDefaultStore(filePath?: string): FloatStore {
  if (typeof indexedDB !== 'undefined') return new IndexedDbFloatStore();
  if (filePath) return new FileFloatStore(filePath);
  throw new Error(
    'No IndexedDB here. Under Node or Bun, pass a file path or implement FloatStore — ' +
      'keeping the float in memory loses the ecash on restart.',
  );
}

// float 영속화.
//
// ⚠️ 이건 캐시가 아니라 **돈**이다. ecash 는 베어러라 잃으면 복구 수단이 없다.
// 그래서 저장소를 고르지 않고 인터페이스로 두되, 환경별 기본을 자동 선택해
// 드롭인을 유지한다(PLAN §6 C1).

import type { Proof } from '@cashu/cashu-ts';

/** 릴레이에 넘겼지만 확정 응답을 못 받은 토큰. **버리면 안 된다.** */
export interface PendingSpend {
  /** 봉투에 실어 보낸 인코딩 토큰. 재시도 시 **바이트 동일하게** 다시 보낸다(§3.6). */
  token: string;
  /** 그 토큰의 원본 proofs. checkstate 로 미사용이면 되살린다. */
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
  /** 민트 URL → 보유 proofs. 민트별로 분리 — 토큰은 민트를 넘나들 수 없다. */
  mints: Record<string, MintBucket>;
  /** 충전 이력. 기간 한도 계산용이자 UI 표시용. */
  topUps: { at: number; sats: number }[];
  /** 지출 이력. "언제 어느 릴레이의 어느 이벤트에 얼마 썼는지" — UI 가 보여줄 유일한 근거다. */
  spends?: SpendRecord[];
  /** 환불 이력. */
  refunds?: RefundRecord[];
}

export interface RefundRecord {
  at: number;
  mint: string;
  /** 실제로 상대가 받은 금액. */
  sentSats: number;
  /** 라이트닝 라우팅 수수료(예약분에서 change 를 뺀 실비). */
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

// ─── 메모리 (테스트·일회성) ──────────────────────────────────────

export class MemoryFloatStore implements FloatStore {
  constructor(private state: FloatState | null = null) {}
  async load(): Promise<FloatState | null> {
    return this.state;
  }
  async save(state: FloatState): Promise<void> {
    this.state = structuredClone(state);
  }
}

// ─── 파일 (Node / Bun / Electron 메인) ───────────────────────────

/**
 * JSON 파일 하나. 쿼리할 게 없어서 SQLite 는 과하다.
 *
 * 임시 파일에 쓰고 rename 한다 — 쓰는 도중 죽으면 원본이 남는다.
 * 돈이라서 half-written 상태를 만들면 안 된다.
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

// ─── IndexedDB (브라우저 / Tauri / Electron 렌더러) ──────────────

const DB_NAME = 'nostr-paywall-float';
const STORE = 'state';
const KEY = 'current';

/**
 * Tauri 는 시스템 웹뷰라 이게 그대로 동작한다 — 별도 어댑터가 필요 없다.
 *
 * ⚠️ 브라우저 저장소는 **내구성이 없다.** Safari ITP 는 스크립트가 쓴 저장소를
 * 7일 뒤 지우고, 다른 브라우저도 압박 시 축출한다. `persist()` 를 요청하지만
 * 승인은 보장되지 않는다. 그래서 float 상한을 작게 유지하는 게 진짜 방어다.
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

  /** 축출 방어. 승인 여부를 돌려주므로 호출자가 상한을 조정할 수 있다. */
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
 * 환경 감지 기본값. 앱이 아무것도 안 정해도 드롭인이 유지된다.
 *
 * Node/Bun 은 경로가 필요하다 — 거기선 앱이 정하는 게 맞다(어디에 둘지는 앱 사정).
 */
export function createDefaultStore(filePath?: string): FloatStore {
  if (typeof indexedDB !== 'undefined') return new IndexedDbFloatStore();
  if (filePath) return new FileFloatStore(filePath);
  throw new Error(
    'IndexedDB 가 없는 환경이다. Node/Bun 이면 파일 경로를 주거나 FloatStore 를 직접 구현할 것 — ' +
      '메모리에만 두면 재시작 때 ecash 를 잃는다.',
  );
}

// 단일 writer 락 (PLAN V9 / §6 C2).
//
// 탭 두 개가 같은 proofs 를 동시에 쓰면 민트에서 한쪽이 죽는다. 손실은 아니지만
// (민트가 이중사용을 막으므로) 발행이 조용히 실패하고, 더 나쁘게는 두 탭이 각자
// 상태를 저장하면서 **한쪽의 저장분을 통째로 덮어쓴다** — 그건 진짜 손실이다.
//
// 그래서 "읽기 → 수정 → 쓰기" 전체를 하나의 임계구역으로 묶는다.

/** 프로세스 안에서만 유효한 직렬화. Node·단일 탭이면 이걸로 충분하다. */
class InProcessMutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    // 앞 작업의 성패와 무관하게 이어 붙인다 — 한 번 실패했다고 락이 죽으면 안 된다.
    const next = this.tail.then(fn, fn);
    this.tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

export interface FloatLock {
  /** 임계구역. 중첩 호출하면 교착하므로 하지 말 것. */
  run<T>(fn: () => Promise<T>): Promise<T>;
}

const LOCK_NAME = 'nostr-paywall-float';

/**
 * 환경에 맞는 락.
 *
 * 브라우저·Tauri 는 **Web Locks API** 로 탭 간 상호배제가 된다. 없으면
 * 프로세스 내 직렬화로 떨어진다(Node 단일 프로세스면 그걸로 충분).
 *
 * ⚠️ Web Locks 가 없는 **다중 탭** 환경은 보호되지 않는다. 그 경우 민트가
 * 이중사용을 막아주므로 돈이 사라지진 않지만 발행이 실패할 수 있다.
 */
export function createLock(): FloatLock {
  const webLocks =
    typeof navigator !== 'undefined' &&
    typeof (navigator as Navigator & { locks?: LockManager }).locks?.request === 'function'
      ? (navigator as Navigator & { locks: LockManager }).locks
      : undefined;

  if (!webLocks) return new InProcessMutex();

  // Web Locks 는 탭 간에만 배타적이다. 같은 탭 안의 동시 호출도 막아야 하므로
  // 프로세스 내 뮤텍스를 겹쳐 쓴다.
  const local = new InProcessMutex();
  return {
    run<T>(fn: () => Promise<T>): Promise<T> {
      return local.run(() => webLocks.request(LOCK_NAME, () => fn()) as Promise<T>);
    },
  };
}

export { InProcessMutex };

// proof 금액 정규화.
//
// **왜 별도 파일인가**: cashu-ts v4 의 `Proof.amount` 는 숫자가 아니라 `Amount`
// 클래스(bigint 래퍼)다. 저장소에 따라 다른 모양으로 되살아난다:
//
//   JSON(파일)          → "1"        문자열  → Number() 되므로 우연히 동작
//   structuredClone(IDB) → {value:1n} 객체    → Number() 하면 **NaN**
//
// 이 차이 때문에 Node 드릴은 통과하는데 브라우저에서만 잔액이 NaN 이 됐다.
// 저장 시점에 **평범한 숫자로 못박아** 환경 차이를 없앤다.

/** 어떤 모양으로 오든 sat 정수로. 못 읽으면 `NaN`(호출자가 알아채야 한다). */
export function amountOf(proof: unknown): number {
  const a = (proof as { amount?: unknown } | null)?.amount;
  if (typeof a === 'number') return a;
  if (typeof a === 'bigint') return Number(a);
  if (typeof a === 'string') return Number(a);
  // Amount 클래스 인스턴스이거나, 프로토타입을 잃은 그 잔해(`{value: 1n}`).
  if (a && typeof a === 'object' && 'value' in a) return Number((a as { value: unknown }).value);
  return Number.NaN;
}

/** 저장·전송 전에 amount 를 숫자로 고정한다. 나머지 필드는 그대로 둔다. */
export function normalizeProof<T>(proof: T): T {
  return { ...(proof as object), amount: amountOf(proof) } as T;
}

export function normalizeProofs<T>(proofs: readonly T[]): T[] {
  return proofs.map(normalizeProof);
}

export function sumSats(proofs: readonly unknown[]): number {
  return proofs.reduce<number>((s, p) => s + amountOf(p), 0);
}

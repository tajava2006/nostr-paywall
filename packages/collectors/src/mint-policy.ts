// 민트 수수료 정책 — **1 sat 가격의 생사가 여기 걸려 있다** (PLAN D13 / §4.1 H1b).
//
// NUT-02: fees = ceil(sum(input_fee_ppk) / 1000), 그리고 sum(inputs) - fees == sum(outputs).
// ppk=100 이면 입력 1~10개당 1 sat 이므로 1 sat proof 는 출력이 0이 되어 **swap 자체가
// 성립하지 않는다**(실측: `Inputs: 0, Outputs: 0`).
//
// 이건 조용히 망가지는 종류의 함정이다 — 설정에 민트 하나 잘못 넣으면 모든 수납이
// 실패하거나 순액 0원이 되는데, 코드는 아무 데서도 안 터진다. 그래서 부팅 게이트로 만든다.

export interface KeysetLike {
  id: string;
  unit: string;
  active: boolean;
  input_fee_ppk?: number;
}

/** NUT-02 수수료 공식. 입력 개수만큼 ppk 를 더하고 1000 으로 올림 나눗셈. */
export function feeForInputs(inputCount: number, inputFeePpk: number): number {
  if (inputCount <= 0) return 0;
  return Math.ceil((inputCount * inputFeePpk) / 1000);
}

/**
 * 해당 unit 의 **활성** 키셋 중 가장 큰 ppk.
 *
 * 가장 큰 값을 쓰는 이유: 클라가 어느 활성 키셋으로 발행할지 우리가 못 고른다.
 * 하나라도 유료면 그 경로로 온 1 sat 은 죽으므로 최악값으로 판정해야 한다.
 * 해당 unit 의 활성 키셋이 없으면 `null`(= 판정 불가, 거부).
 */
export function maxActiveInputFeePpk(keysets: readonly KeysetLike[], unit = 'sat'): number | null {
  const active = keysets.filter((k) => k.active && k.unit === unit);
  if (active.length === 0) return null;
  return Math.max(...active.map((k) => k.input_fee_ppk ?? 0));
}

export interface MintFeePolicy {
  mint: string;
  ppk: number | null;
  /** 이 민트로 1 sat 결제가 가능한가. */
  zeroFee: boolean;
}

export type FetchLike = (url: string) => Promise<{ json(): Promise<unknown> }>;

/** 민트의 `/v1/keysets` 를 읽어 수수료 정책을 판정한다. */
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
 * 부팅 게이트. allowlist 의 모든 민트가 ppk==0 인지 확인하고, 아니면 **던진다**.
 *
 * 릴레이를 못 띄우게 하는 게 맞다 — 이 조건이 깨진 채로 뜨면 유저 돈만 받고
 * 수납은 실패하는 상태로 조용히 굴러간다.
 */
export async function assertZeroFeeMints(
  mints: readonly string[],
  unit = 'sat',
  fetchImpl?: FetchLike,
): Promise<MintFeePolicy[]> {
  if (mints.length === 0) throw new Error('민트 allowlist 가 비어 있다');
  const policies = await Promise.all(mints.map((m) => fetchMintFeePolicy(m, unit, fetchImpl)));
  const bad = policies.filter((p) => !p.zeroFee);
  if (bad.length > 0) {
    const detail = bad.map((p) => `${p.mint} (input_fee_ppk=${p.ppk ?? '알 수 없음'})`).join(', ');
    throw new Error(
      `1 sat 결제가 불가능한 민트가 allowlist 에 있다: ${detail}. ` +
        `NUT-02 상 수수료가 원금 이상이라 swap 이 성립하지 않는다 — input_fee_ppk==0 인 민트만 쓸 것.`,
    );
  }
  return policies;
}

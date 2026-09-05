// OK 응답 왕복 테스트. 릴레이의 조립과 클라의 해석이 갈리면 조용히 망가지므로
// 반드시 build → parse 왕복으로 확인한다.

import { describe, expect, it } from 'vitest';
import {
  extractRefundToken,
  okDuplicate,
  okPaymentInvalid,
  okPaymentRequired,
  okInProgress,
  okRefund,
  parseOkReason,
} from '../src/ok.js';

describe('왕복', () => {
  it('payment-required', () => {
    const reason = okPaymentRequired('1 sat per tagged note');
    expect(parseOkReason(false, reason)).toEqual({
      kind: 'payment-required',
      message: '1 sat per tagged note',
    });
  });

  it('payment-invalid', () => {
    const reason = okPaymentInvalid('proof already spent');
    expect(parseOkReason(false, reason)).toEqual({
      kind: 'payment-invalid',
      message: 'proof already spent',
    });
  });

  it('duplicate 는 accepted=true 로 온다 (NIP-01) — 무과금 통과이자 재시도의 정상 종착지', () => {
    expect(parseOkReason(true, okDuplicate())).toEqual({ kind: 'duplicate' });
  });

  it('처리 중은 rate-limited — payment-invalid 를 쓰면 "재시도 말라"는 잘못된 신호가 된다', () => {
    const out = parseOkReason(false, okInProgress());
    expect(out.kind).toBe('rejected');
    if (out.kind === 'rejected') expect(out.prefix).toBe('rate-limited');
  });

  it('환불', () => {
    const reason = okRefund('cashuAeyJ0b2tlbiI6W10=');
    expect(parseOkReason(false, reason)).toEqual({
      kind: 'refunded',
      token: 'cashuAeyJ0b2tlbiI6W10=',
      message: 'storage failed',
    });
  });
});

describe('해석', () => {
  it('빈 reason 으로 수락된 건 accepted', () => {
    expect(parseOkReason(true, '')).toEqual({ kind: 'accepted' });
  });

  it('환불은 접두사보다 우선한다 — 돈 딸린 응답을 일반 오류로 흘리면 그대로 잃는다', () => {
    const outcome = parseOkReason(false, 'error: db down; refund=cashuABC');
    expect(outcome.kind).toBe('refunded');
  });

  it('모르는 거부는 접두사를 보존해서 넘긴다', () => {
    expect(parseOkReason(false, 'rate-limited: slow down there chief')).toEqual({
      kind: 'rejected',
      prefix: 'rate-limited',
      message: 'slow down there chief',
    });
  });

  it('접두사가 없어도 안 터진다', () => {
    expect(parseOkReason(false, 'just a message')).toEqual({
      kind: 'rejected',
      prefix: '',
      message: 'just a message',
    });
  });

  it('사람이 읽을 문장이 살아 있다 — 일반 클라는 이 문자열을 토스트에 그대로 띄운다', () => {
    const reason = okPaymentRequired('1 sat per reply. see relay info for how to pay.');
    expect(reason).toContain('1 sat per reply');
  });
});

describe('extractRefundToken', () => {
  it('공백 앞까지만 토큰으로 본다', () => {
    expect(extractRefundToken('error: x; refund=cashuABC trailing words')).toBe('cashuABC');
  });

  it('없으면 null', () => {
    expect(extractRefundToken('error: db down')).toBeNull();
    expect(extractRefundToken('refund=')).toBeNull();
  });
});

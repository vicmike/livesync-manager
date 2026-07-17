import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfirmTokenService } from './confirmTokens.js';

describe('ConfirmTokenService', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('accepts a fresh token exactly once', () => {
    const service = new ConfirmTokenService();
    const token = service.issue('vault-delete', 'v1');
    expect(service.consume('vault-delete', 'v1', token)).toBe(true);
    expect(service.consume('vault-delete', 'v1', token)).toBe(false);
  });

  it('binds tokens to the operation and resource', () => {
    const service = new ConfirmTokenService();
    expect(service.consume('vault-delete', 'v1', service.issue('device-revoke', 'v1'))).toBe(false);
    expect(service.consume('vault-delete', 'v1', service.issue('vault-delete', 'v2'))).toBe(false);
    expect(service.consume('vault-delete', 'v1', 'not-a-token')).toBe(false);
  });

  it('expires tokens after five minutes', () => {
    const service = new ConfirmTokenService();
    const token = service.issue('vault-delete', 'v1');
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);
    expect(service.consume('vault-delete', 'v1', token)).toBe(false);
  });
});

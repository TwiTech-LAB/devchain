import { renderHook, act } from '@testing-library/react';
import { SessionApiError, type ApiErrorPayload } from '@/ui/lib/sessions';
import {
  getMcpProviderDetails,
  isMcpNotConfigured,
  restoreConflictTitle,
  runTrackedOperation,
  useLifecyclePendingTracker,
  type LifecyclePendingTracker,
} from './session-lifecycle-core';

function apiError(
  status: number,
  code: string,
  details?: ApiErrorPayload['details'],
): SessionApiError {
  return new SessionApiError('boom', status, {
    statusCode: status,
    code: 'http_exception',
    message: 'boom',
    details: { code, ...details },
    timestamp: '2026-01-01T00:00:00Z',
    path: '/api/sessions',
  });
}

describe('SessionApiError classification', () => {
  describe('isMcpNotConfigured', () => {
    it('is true only for the MCP_NOT_CONFIGURED code', () => {
      expect(isMcpNotConfigured(apiError(400, 'MCP_NOT_CONFIGURED'))).toBe(true);
      expect(isMcpNotConfigured(apiError(400, 'OTHER'))).toBe(false);
      expect(isMcpNotConfigured(new Error('nope'))).toBe(false);
    });
  });

  describe('getMcpProviderDetails', () => {
    it('extracts string provider fields, leaving non-strings undefined', () => {
      const err = apiError(400, 'MCP_NOT_CONFIGURED', {
        providerId: 'prov-1',
        providerName: 'Claude',
      });
      expect(getMcpProviderDetails(err)).toEqual({ providerId: 'prov-1', providerName: 'Claude' });
      expect(getMcpProviderDetails(apiError(400, 'MCP_NOT_CONFIGURED'))).toEqual({
        providerId: undefined,
        providerName: undefined,
      });
      expect(getMcpProviderDetails(new Error('x'))).toEqual({
        providerId: undefined,
        providerName: undefined,
      });
    });
  });

  describe('restoreConflictTitle', () => {
    it('maps 409 codes to specific titles and falls back otherwise', () => {
      expect(restoreConflictTitle(apiError(409, 'PROVIDER_MISMATCH'))).toBe('Provider mismatch');
      expect(restoreConflictTitle(apiError(409, 'NO_PROVIDER_SESSION_ID'))).toBe('Cannot restore');
      expect(restoreConflictTitle(apiError(409, 'INVALID_SESSION_STATE'))).toBe(
        'Invalid session state',
      );
      expect(restoreConflictTitle(apiError(409, 'SOMETHING_ELSE'))).toBe('Restore failed');
      expect(restoreConflictTitle(apiError(500, 'PROVIDER_MISMATCH'))).toBe('Restore failed');
      expect(restoreConflictTitle(new Error('x'))).toBe('Restore failed');
    });
  });
});

describe('useLifecyclePendingTracker', () => {
  it('sets, reads, and clears actions by key', () => {
    const { result } = renderHook(() => useLifecyclePendingTracker());
    act(() => result.current.setAction('a', 'launching'));
    expect(result.current.actionFor('a')).toBe('launching');
    expect(result.current.actions).toEqual({ a: 'launching' });
    act(() => result.current.clear('a'));
    expect(result.current.actionFor('a')).toBeUndefined();
    expect(result.current.actions).toEqual({});
  });

  it('recordOf projects one or more actions into a boolean record', () => {
    const { result } = renderHook(() => useLifecyclePendingTracker());
    act(() => {
      result.current.setAction('a', 'launching');
      result.current.setAction('b', 'terminating');
      result.current.setAction('c', 'restarting');
    });
    expect(result.current.recordOf('launching')).toEqual({ a: true });
    // chat's launchingAgentIds folds launching + terminating together.
    expect(result.current.recordOf('launching', 'terminating')).toEqual({ a: true, b: true });
  });

  it('singleKeyOf returns the sole key in an action or null', () => {
    const { result } = renderHook(() => useLifecyclePendingTracker());
    expect(result.current.singleKeyOf('restarting')).toBeNull();
    act(() => result.current.setAction('x', 'restarting'));
    expect(result.current.singleKeyOf('restarting')).toBe('x');
    expect(result.current.singleKeyOf('launching')).toBeNull();
  });
});

describe('runTrackedOperation', () => {
  function makeTracker(): { tracker: LifecyclePendingTracker; log: string[] } {
    const log: string[] = [];
    const state: Record<string, string> = {};
    const tracker: LifecyclePendingTracker = {
      actions: state,
      setAction: (key, action) => {
        log.push(`set:${key}:${action}`);
        if (action) state[key] = action;
        else delete state[key];
      },
      clear: (key) => {
        log.push(`clear:${key}`);
        delete state[key];
      },
      actionFor: (key) => state[key] as never,
      recordOf: () => ({}),
      singleKeyOf: () => null,
    };
    return { tracker, log };
  }

  it('sets pending, returns the result, and clears pending on success', async () => {
    const { tracker, log } = makeTracker();
    const onError = jest.fn();
    const result = await runTrackedOperation(tracker, 'k', 'launching', {
      run: async () => 'ok',
      onError,
    });
    expect(result).toBe('ok');
    expect(onError).not.toHaveBeenCalled();
    expect(log).toEqual(['set:k:launching', 'clear:k']);
  });

  it('dispatches onError, returns null, and still clears pending on throw', async () => {
    const { tracker, log } = makeTracker();
    const onError = jest.fn();
    const boom = new Error('boom');
    const result = await runTrackedOperation(tracker, 'k', 'terminating', {
      run: async () => {
        throw boom;
      },
      onError,
    });
    expect(result).toBeNull();
    expect(onError).toHaveBeenCalledWith(boom);
    expect(log).toEqual(['set:k:terminating', 'clear:k']);
  });
});

import { renderHook, act } from '@testing-library/react';
import { useProviderProbe, type ProviderProbeFormSlice } from './useProviderProbe';

// ── toast helpers: capture calls ──
const toast = jest.fn();
const showSuccess = jest.fn();
const showError = jest.fn();
jest.mock('@/ui/lib/toast-helpers', () => ({
  useToastHelpers: () => ({ toast, showSuccess, showError }),
  getErrorMessage: (_e: unknown, fallback: string) => fallback,
}));

interface FormValues extends ProviderProbeFormSlice {
  binPath: string;
}

const idleForm: FormValues = {
  binPath: '/bin/claude',
  oneMillionContextEnabled: false,
  autoCompactThreshold1m: '',
  autoCompactThreshold: '',
};

describe('useProviderProbe', () => {
  let setValues: jest.Mock;
  let lastValues: FormValues;

  beforeEach(() => {
    lastValues = { ...idleForm };
    setValues = jest.fn((updater: (prev: FormValues) => FormValues) => {
      lastValues = updater(lastValues);
    });
    toast.mockClear();
    showError.mockClear();
    (global as unknown as { fetch: unknown }).fetch = jest.fn();
  });

  function renderProbe() {
    return renderHook(() => useProviderProbe<FormValues>({ setValues }));
  }

  function mockFetch(response: unknown) {
    ((global as unknown as { fetch: unknown }).fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => response,
    });
  }

  // ============================================
  // State machine + threshold interplay
  // ============================================

  it('transitions idle → probing → supported on a supported probe, setting the 50%/95% defaults', async () => {
    mockFetch({ supported: true, status: 'ok' });
    const { result } = renderProbe();

    expect(result.current.probeStatus).toBe('idle');

    await act(async () => {
      await result.current.probe('p-1');
    });

    expect(result.current.probeStatus).toBe('supported');
    expect(setValues).toHaveBeenCalledTimes(1);
    expect(lastValues).toEqual({
      binPath: '/bin/claude',
      oneMillionContextEnabled: true,
      autoCompactThreshold1m: '50',
      autoCompactThreshold: '95',
    });
    expect(toast).toHaveBeenCalledWith({
      title: '1M context supported',
      description: 'Threshold set to 50%.',
    });
    expect(showError).not.toHaveBeenCalled();
  });

  it('transitions to unsupported (destructive toast) and disables 1M, preserving other fields', async () => {
    mockFetch({ supported: false, status: 'unsupported', detail: 'old binary' });
    const { result } = renderProbe();

    await act(async () => {
      await result.current.probe('p-1');
    });

    expect(result.current.probeStatus).toBe('unsupported');
    expect(lastValues.oneMillionContextEnabled).toBe(false);
    // Other threshold fields untouched on the non-supported branch.
    expect(lastValues.autoCompactThreshold1m).toBe('');
    expect(lastValues.autoCompactThreshold).toBe('');
    expect(toast).toHaveBeenCalledWith({
      title: '1M context not supported',
      description: 'old binary',
      variant: 'destructive',
    });
  });

  it('falls back to the default detail copy when the API omits detail on unsupported', async () => {
    mockFetch({ supported: false, status: 'unsupported' });
    const { result } = renderProbe();

    await act(async () => {
      await result.current.probe('p-1');
    });

    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: '1M context not supported',
        description: 'Binary does not support 1M.',
      }),
    );
  });

  it('routes a launch_failure / timeout status to the error state with a destructive toast', async () => {
    mockFetch({ supported: false, status: 'launch_failure', detail: 'exited 1' });
    const { result } = renderProbe();

    await act(async () => {
      await result.current.probe('p-1');
    });

    expect(result.current.probeStatus).toBe('error');
    expect(lastValues.oneMillionContextEnabled).toBe(false);
    expect(toast).toHaveBeenCalledWith({
      title: 'Probe failed',
      description: 'exited 1',
      variant: 'destructive',
    });
    expect(showError).not.toHaveBeenCalled();
  });

  it('falls back to `Status: <status>` copy when the API omits detail on a non-unsupported failure', async () => {
    mockFetch({ supported: false, status: 'timeout' });
    const { result } = renderProbe();

    await act(async () => {
      await result.current.probe('p-1');
    });

    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Probe failed',
        description: 'Status: timeout',
      }),
    );
  });

  it('uses showError (not raw toast) when the fetch throws, and still disables 1M', async () => {
    ((global as unknown as { fetch: unknown }).fetch as jest.Mock).mockResolvedValue({
      ok: false,
      json: async () => ({ message: 'server borked' }),
    });
    const { result } = renderProbe();

    await act(async () => {
      await result.current.probe('p-1');
    });

    expect(result.current.probeStatus).toBe('error');
    expect(lastValues.oneMillionContextEnabled).toBe(false);
    // The thrown-exception branch uses showError; the API-result branches use toast.
    expect(showError).toHaveBeenCalledWith({
      title: 'Probe failed',
      description: 'Failed to probe 1M context.',
    });
    expect(toast).not.toHaveBeenCalled();
  });

  it('enters the probing state synchronously before awaiting the fetch', async () => {
    let resolveFetch!: (v: { ok: true; json: () => Promise<unknown> }) => void;
    ((global as unknown as { fetch: unknown }).fetch as jest.Mock).mockReturnValue(
      new Promise((r) => {
        resolveFetch = r;
      }),
    );
    const { result } = renderProbe();

    let pending!: Promise<void>;
    act(() => {
      pending = result.current.probe('p-1');
    });
    // Synchronous transition to 'probing' before the fetch resolves.
    expect(result.current.probeStatus).toBe('probing');

    await act(async () => {
      resolveFetch({ ok: true, json: async () => ({ supported: true, status: 'ok' }) });
      await pending;
    });
    expect(result.current.probeStatus).toBe('supported');
  });

  // ============================================
  // binPath-change rollback
  // ============================================

  describe('binPathChangePatch', () => {
    it('returns the 1M rollback for Claude when 1M is currently enabled', () => {
      const { result } = renderProbe();
      const prev: ProviderProbeFormSlice = {
        oneMillionContextEnabled: true,
        autoCompactThreshold1m: '50',
        autoCompactThreshold: '95',
      };

      expect(result.current.binPathChangePatch(prev, true)).toEqual({
        oneMillionContextEnabled: false,
        autoCompactThreshold1m: '',
        autoCompactThreshold: '95',
      });
    });

    it('returns an empty patch for Claude when 1M is disabled (nothing to roll back)', () => {
      const { result } = renderProbe();
      const prev: ProviderProbeFormSlice = {
        oneMillionContextEnabled: false,
        autoCompactThreshold1m: '',
        autoCompactThreshold: '',
      };

      expect(result.current.binPathChangePatch(prev, true)).toEqual({});
    });

    it('returns an empty patch for non-Claude providers even if 1M is enabled', () => {
      const { result } = renderProbe();
      const prev: ProviderProbeFormSlice = {
        oneMillionContextEnabled: true,
        autoCompactThreshold1m: '50',
        autoCompactThreshold: '95',
      };

      expect(result.current.binPathChangePatch(prev, false)).toEqual({});
    });

    it('is a pure function — does not mutate prev or call setValues', () => {
      const { result } = renderProbe();
      const prev: ProviderProbeFormSlice = {
        oneMillionContextEnabled: true,
        autoCompactThreshold1m: '50',
        autoCompactThreshold: '95',
      };
      const snapshot = { ...prev };

      result.current.binPathChangePatch(prev, true);
      expect(prev).toEqual(snapshot);
      expect(setValues).not.toHaveBeenCalled();
    });
  });

  describe('onBinPathChange', () => {
    it('resets a stale "supported" status to idle for Claude', async () => {
      mockFetch({ supported: true, status: 'ok' });
      const { result } = renderProbe();
      await act(async () => {
        await result.current.probe('p-1');
      });
      expect(result.current.probeStatus).toBe('supported');

      act(() => {
        result.current.onBinPathChange(true);
      });
      expect(result.current.probeStatus).toBe('idle');
    });

    it('is a no-op when the status is not "supported" (e.g. probing)', () => {
      const { result } = renderProbe();
      expect(result.current.probeStatus).toBe('idle');

      act(() => {
        result.current.onBinPathChange(true);
      });
      expect(result.current.probeStatus).toBe('idle');
    });

    it('is a no-op for non-Claude providers', async () => {
      mockFetch({ supported: true, status: 'ok' });
      const { result } = renderProbe();
      await act(async () => {
        await result.current.probe('p-1');
      });
      expect(result.current.probeStatus).toBe('supported');

      act(() => {
        result.current.onBinPathChange(false);
      });
      // Non-Claude binPath edits do not clear a supported probe.
      expect(result.current.probeStatus).toBe('supported');
    });
  });

  // ============================================
  // reset + setProbeStatus
  // ============================================

  it('reset returns the status to idle from any state', async () => {
    mockFetch({ supported: true, status: 'ok' });
    const { result } = renderProbe();
    await act(async () => {
      await result.current.probe('p-1');
    });
    expect(result.current.probeStatus).toBe('supported');

    act(() => {
      result.current.reset();
    });
    expect(result.current.probeStatus).toBe('idle');
  });

  it('exposes setProbeStatus for the page to seed "supported" when editing a 1M-enabled provider', () => {
    const { result } = renderProbe();
    expect(result.current.probeStatus).toBe('idle');

    act(() => {
      result.current.setProbeStatus('supported');
    });
    expect(result.current.probeStatus).toBe('supported');
  });
});

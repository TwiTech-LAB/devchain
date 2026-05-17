import { useState, useCallback, useEffect, useRef } from 'react';

export type QrAuthStatus =
  | 'idle'
  | 'loading'
  | 'waiting'
  | 'approved'
  | 'finalizing'
  | 'success'
  | 'denied'
  | 'expired'
  | 'error';

export interface AuthTokens {
  accessToken: string;
  refreshToken?: string;
  [key: string]: unknown;
}

export interface QrAuthState {
  status: QrAuthStatus;
  qrPayload: string | null;
  crossCheckCode: string | null;
  expiresAt: Date | null;
  channelId: string | null;
  pollToken: string | null;
  tokens: AuthTokens | null;
  error: string | null;
}

const INITIAL_STATE: QrAuthState = {
  status: 'idle',
  qrPayload: null,
  crossCheckCode: null,
  expiresAt: null,
  channelId: null,
  pollToken: null,
  tokens: null,
  error: null,
};

export function useQrAuth(identityServiceUrl: string, mode: 'claim' | 'provision') {
  const [state, setState] = useState<QrAuthState>(INITIAL_STATE);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const abortedRef = useRef(false);

  const clearPollInterval = useCallback(() => {
    if (pollIntervalRef.current !== null) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
  }, []);

  const start = useCallback(async () => {
    if (abortedRef.current) return;
    setState({ ...INITIAL_STATE, status: 'loading' });
    clearPollInterval();

    const url =
      mode === 'provision' ? '/api/cloud/qr/initiate' : `${identityServiceUrl}/auth/qr/initiate`;

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ machineLabel: window.location.hostname }),
      });
      if (!res.ok) throw new Error(`initiate:${res.status}`);
      const data = await res.json();
      if (abortedRef.current) return;
      setState({
        status: 'waiting',
        qrPayload: data.qrPayload,
        crossCheckCode: data.crossCheckCode,
        expiresAt: new Date(data.expiresAt),
        channelId: data.channelId,
        pollToken: data.pollToken,
        tokens: null,
        error: null,
      });
    } catch (err) {
      if (abortedRef.current) return;
      setState((s) => ({
        ...s,
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }, [identityServiceUrl, mode, clearPollInterval]);

  // Polling effect — starts when status='waiting'
  useEffect(() => {
    if (state.status !== 'waiting' || !state.channelId || !state.pollToken) return;

    const channelId = state.channelId;
    const pollToken = state.pollToken;

    const tick = async () => {
      if (abortedRef.current) return;
      try {
        const res = await fetch(`${identityServiceUrl}/auth/qr/poll/${channelId}`, {
          headers: { 'X-Poll-Token': pollToken },
        });
        if (!res.ok) {
          if (abortedRef.current) return;
          setState((s) => ({ ...s, status: 'error', error: `poll:${res.status}` }));
          return;
        }
        const data = await res.json();
        if (abortedRef.current) return;

        if (data.status === 'pending') return;

        // Terminal states — clear polling
        clearPollInterval();

        if (data.status === 'approved') {
          setState((s) => ({ ...s, status: 'finalizing' }));
          try {
            const fin = await fetch(`${identityServiceUrl}/auth/qr/finalize`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ channelId, pollToken }),
            });
            if (!fin.ok) {
              if (abortedRef.current) return;
              setState((s) => ({ ...s, status: 'error', error: `finalize:${fin.status}` }));
              return;
            }
            const tokens = await fin.json();
            if (abortedRef.current) return;
            setState((s) => ({ ...s, status: 'success', tokens }));
          } catch (err) {
            if (abortedRef.current) return;
            setState((s) => ({
              ...s,
              status: 'error',
              error: err instanceof Error ? err.message : String(err),
            }));
          }
        } else if (data.status === 'redeemed') {
          setState((s) => ({ ...s, status: 'success' }));
        } else {
          // 'denied' | 'expired' | unknown terminal
          setState((s) => ({ ...s, status: data.status }));
        }
      } catch (err) {
        if (abortedRef.current) return;
        setState((s) => ({
          ...s,
          status: 'error',
          error: err instanceof Error ? err.message : String(err),
        }));
      }
    };

    pollIntervalRef.current = setInterval(tick, 2500);

    return () => {
      clearPollInterval();
    };
  }, [state.status, state.channelId, state.pollToken, identityServiceUrl, clearPollInterval]);

  // Cleanup on unmount (StrictMode-safe: reset on each mount)
  useEffect(() => {
    abortedRef.current = false;
    return () => {
      abortedRef.current = true;
      clearPollInterval();
    };
  }, [clearPollInterval]);

  const cancel = useCallback(() => {
    clearPollInterval();
    setState({ ...INITIAL_STATE });
  }, [clearPollInterval]);

  const retry = useCallback(() => {
    setState({ ...INITIAL_STATE });
    void start();
  }, [start]);

  return { ...state, start, cancel, retry };
}

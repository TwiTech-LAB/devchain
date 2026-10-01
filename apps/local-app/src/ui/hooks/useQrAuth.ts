import { useState, useCallback, useEffect, useRef } from 'react';
import { HOME_BACKEND, apiFetch, type BackendId } from '@/ui/lib/api-transport';

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
  /** Safety number for the paired device, once E2EE pairing has completed (Task:8). */
  safetyNumber: string | null;
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
  safetyNumber: null,
};

/** Relayed device E2EE material the PC receives back through poll/finalize (Task:4). */
interface DeviceE2eeExchange {
  deviceEncPubKey: string;
  deviceEncKid: string;
  pairingMac: string;
  installId?: string;
  deviceName?: string;
}

// base64url <-> JSON helpers for the QR payload (ASCII-only fields, so btoa/atob are safe).
function decodeB64UrlJson(raw: string): Record<string, unknown> {
  const urlSafe = raw.replace(/-/g, '+').replace(/_/g, '/');
  const padded = urlSafe + '='.repeat((4 - (urlSafe.length % 4)) % 4);
  return JSON.parse(atob(padded)) as Record<string, unknown>;
}
function encodeB64UrlJson(obj: Record<string, unknown>): string {
  return btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A QR payload may only be displayed once it carries this PC's E2EE key material. */
type SecureQrResult = { ok: true; payload: string } | { ok: false; reason: string };

// Ask the local backend for this PC's E2EE public key + a fresh pairing secret, and fold
// them into the QR payload under `e2ee` (`pub`/`kid`/`sec`/`cid`). FAIL CLOSED: if the
// E2EE material can't be obtained or folded in, return an error reason instead of a
// plaintext payload — the caller MUST NOT display a non-encrypted QR (a plaintext pairing
// would silently downgrade the link to TLS-only). The pairingSecret travels ONLY in the
// QR, never to the relay.
async function buildSecureQrPayload(
  rawPayload: string,
  channelId: string,
  backend: BackendId,
): Promise<SecureQrResult> {
  if (!rawPayload || !channelId) {
    return { ok: false, reason: 'the pairing channel was incomplete (missing channel id).' };
  }
  let res: Response;
  try {
    res = await apiFetch(
      '/api/e2ee/pairing/begin',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channelId }),
      },
      { backend },
    );
  } catch (err) {
    return {
      ok: false,
      reason: `the local encryption service was unreachable (${err instanceof Error ? err.message : String(err)}).`,
    };
  }
  if (!res.ok) {
    return { ok: false, reason: `the local encryption service returned HTTP ${res.status}.` };
  }
  let e: { pcEncPubKey?: string; pcEncKid?: string; pairingSecret?: string };
  try {
    e = await res.json();
  } catch {
    return { ok: false, reason: 'the local encryption service returned an unreadable response.' };
  }
  if (!e?.pcEncPubKey || !e?.pcEncKid || !e?.pairingSecret) {
    return {
      ok: false,
      reason: 'the local encryption service did not return a public key + pairing secret.',
    };
  }
  let decoded: Record<string, unknown>;
  try {
    decoded = decodeB64UrlJson(rawPayload);
  } catch {
    return { ok: false, reason: 'the pairing payload was not in the expected format.' };
  }
  decoded.e2ee = { pub: e.pcEncPubKey, kid: e.pcEncKid, sec: e.pairingSecret, cid: channelId };
  return { ok: true, payload: encodeB64UrlJson(decoded) };
}

export function useQrAuth(
  identityServiceUrl: string,
  mode: 'claim' | 'provision',
  // The backend whose cloud session and E2EE keys the QR belongs to — a remote
  // id pairs the phone with that instance, not this PC.
  backend: BackendId = HOME_BACKEND,
) {
  const [state, setState] = useState<QrAuthState>(INITIAL_STATE);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const abortedRef = useRef(false);
  const e2eeCompletedRef = useRef(false);

  const clearPollInterval = useCallback(() => {
    if (pollIntervalRef.current !== null) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
  }, []);

  // Verify + trust the device key the relay carried back. Best-effort and additive:
  // a failure (e.g. MAC mismatch on a key-substituting relay → backend fails closed)
  // leaves the device un-trusted but never blocks login. Runs at most once.
  const completeE2ee = useCallback(
    async (channelId: string, e2ee: DeviceE2eeExchange) => {
      if (e2eeCompletedRef.current) return;
      e2eeCompletedRef.current = true;
      try {
        const res = await apiFetch(
          '/api/e2ee/pairing/complete',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              channelId,
              deviceEncPubKey: e2ee.deviceEncPubKey,
              deviceEncKid: e2ee.deviceEncKid,
              pairingMac: e2ee.pairingMac,
              ...(e2ee.installId !== undefined ? { installId: e2ee.installId } : {}),
              ...(e2ee.deviceName !== undefined ? { label: e2ee.deviceName } : {}),
            }),
          },
          { backend },
        );
        if (!res.ok) return;
        // Surface the safety number so the user can compare both screens (Task:8). The QR
        // path is already auto-verified; this is a reassurance/compare confirmation.
        const { kid } = (await res.json()) as { kid?: string };
        if (!kid) return;
        const snRes = await apiFetch(
          `/api/e2ee/devices/${encodeURIComponent(kid)}/safety-number`,
          undefined,
          { backend },
        );
        if (!snRes.ok) return;
        const { safetyNumber } = (await snRes.json()) as { safetyNumber?: string };
        if (safetyNumber) setState((s) => ({ ...s, safetyNumber }));
      } catch {
        // Non-fatal: the peer simply remains unverified; pairing/login still succeeds.
      }
    },
    [backend],
  );

  const start = useCallback(async () => {
    if (abortedRef.current) return;
    setState({ ...INITIAL_STATE, status: 'loading' });
    clearPollInterval();
    e2eeCompletedRef.current = false;

    const url =
      mode === 'provision' ? '/api/cloud/qr/initiate' : `${identityServiceUrl}/auth/qr/initiate`;

    try {
      const res = await apiFetch(
        url,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ machineLabel: window.location.hostname }),
        },
        // The provision QR is minted by the selected backend's cloud session; the
        // claim QR comes straight from the identity service (never rewritten).
        { backend: mode === 'provision' ? backend : HOME_BACKEND },
      );
      if (!res.ok) throw new Error(`initiate:${res.status}`);
      const data = await res.json();
      if (abortedRef.current) return;

      // Embed this PC's E2EE public key + a pairing secret into the QR via the on-screen
      // (visual) channel. The pairingSecret NEVER goes to the relay; the phone reads it
      // off the screen and MACs its key with it (Task:4). FAIL CLOSED: if the E2EE layer
      // is unavailable we surface an error and DO NOT render a plaintext-pairing QR — a
      // non-encrypted QR would silently downgrade the link to TLS-only.
      const secure = await buildSecureQrPayload(data.qrPayload, data.channelId, backend);
      if (abortedRef.current) return;
      if (!secure.ok) {
        setState((s) => ({
          ...s,
          status: 'error',
          error: `Can't start an encrypted pairing — ${secure.reason} No QR code was shown, so the connection can't be downgraded. Make sure the app finished starting, then retry.`,
        }));
        return;
      }

      setState({
        status: 'waiting',
        qrPayload: secure.payload,
        crossCheckCode: data.crossCheckCode,
        expiresAt: new Date(data.expiresAt),
        channelId: data.channelId,
        pollToken: data.pollToken,
        tokens: null,
        error: null,
        safetyNumber: null,
      });
    } catch (err) {
      if (abortedRef.current) return;
      setState((s) => ({
        ...s,
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }, [identityServiceUrl, mode, backend, clearPollInterval]);

  // Polling effect — starts when status='waiting'
  useEffect(() => {
    if (state.status !== 'waiting' || !state.channelId || !state.pollToken) return;

    const channelId = state.channelId;
    const pollToken = state.pollToken;

    const tick = async () => {
      if (abortedRef.current) return;
      try {
        const res = await apiFetch(
          `${identityServiceUrl}/auth/qr/poll/${channelId}`,
          { headers: { 'X-Poll-Token': pollToken } },
          { backend: 'home' },
        );
        if (!res.ok) {
          if (abortedRef.current) return;
          setState((s) => ({ ...s, status: 'error', error: `poll:${res.status}` }));
          return;
        }
        const data = await res.json();
        if (abortedRef.current) return;

        // The relay carries the device's key + MAC back once it has scanned+replied.
        // Verify + trust it (additive; never blocks the auth flow).
        if (data.e2ee) void completeE2ee(channelId, data.e2ee);

        if (data.status === 'pending') return;

        // Terminal states — clear polling
        clearPollInterval();

        if (data.status === 'approved') {
          setState((s) => ({ ...s, status: 'finalizing' }));
          try {
            const fin = await apiFetch(
              `${identityServiceUrl}/auth/qr/finalize`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ channelId, pollToken }),
              },
              { backend: 'home' },
            );
            if (!fin.ok) {
              if (abortedRef.current) return;
              setState((s) => ({ ...s, status: 'error', error: `finalize:${fin.status}` }));
              return;
            }
            const tokens = await fin.json();
            if (abortedRef.current) return;
            if (tokens?.e2ee) void completeE2ee(channelId, tokens.e2ee);
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
  }, [
    state.status,
    state.channelId,
    state.pollToken,
    identityServiceUrl,
    clearPollInterval,
    completeE2ee,
  ]);

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

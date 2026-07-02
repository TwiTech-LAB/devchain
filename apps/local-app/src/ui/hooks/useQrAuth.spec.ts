/** @jest-environment jsdom */

import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useQrAuth } from './useQrAuth';

const IDENTITY_URL = 'http://localhost:3002';

function mockFetch(responses: { ok?: boolean; status?: number; json?: () => Promise<unknown> }[]) {
  const queue = responses.map((r) => ({
    ok: r.ok ?? true,
    status: r.status ?? 200,
    json: r.json ?? (async () => ({})),
  }));
  let callIndex = 0;
  const fn = jest.fn(async () => {
    const response = callIndex < queue.length ? queue[callIndex++] : queue[queue.length - 1];
    return response;
  });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

// base64url-encode a QR payload object the way the cloud/identity initiate endpoint does —
// `buildSecureQrPayload` decodes this to fold in the e2ee block, so it must be real b64url.
const b64url = (obj: unknown) =>
  btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const decode = (raw: string) => {
  const s = raw.replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(atob(s + '='.repeat((4 - (s.length % 4)) % 4)));
};
const validPayload = (over: Record<string, unknown> = {}) =>
  b64url({ v: 1, p: 'abc', u: IDENTITY_URL, c: 'ABCD', m: 'claim', ...over });

// A successful `/api/e2ee/pairing/begin` response. The QR is now FAIL-CLOSED: `start()`
// requires this to succeed, otherwise it errors instead of showing a plaintext QR.
const beginOk = {
  json: async () => ({ pcEncPubKey: 'pcpub', pcEncKid: 'pckid', pairingSecret: 'sec' }),
};

const initiateOk = (over: Record<string, unknown> = {}) => ({
  json: async () => ({
    qrPayload: validPayload(),
    crossCheckCode: 'ABCD',
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
    channelId: 'ch-1',
    pollToken: 'pt-1',
    ...over,
  }),
});

describe('useQrAuth', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  describe('initial state', () => {
    it('starts in idle state', () => {
      const { result } = renderHook(() => useQrAuth(IDENTITY_URL, 'claim'));
      expect(result.current.status).toBe('idle');
      expect(result.current.qrPayload).toBeNull();
      expect(result.current.crossCheckCode).toBeNull();
      expect(result.current.tokens).toBeNull();
      expect(result.current.error).toBeNull();
    });
  });

  describe('start() — claim mode', () => {
    it('calls identityServiceUrl/auth/qr/initiate and shows an E2EE-augmented QR', async () => {
      mockFetch([initiateOk(), beginOk]);

      const { result } = renderHook(() => useQrAuth(IDENTITY_URL, 'claim'));

      await act(async () => {
        await result.current.start();
      });

      expect(result.current.status).toBe('waiting');
      expect(global.fetch).toHaveBeenCalledWith(
        `${IDENTITY_URL}/auth/qr/initiate`,
        expect.objectContaining({ method: 'POST' }),
      );
      const decoded = decode(result.current.qrPayload!);
      expect(decoded.p).toBe('abc'); // original fields preserved
      expect(decoded.e2ee).toEqual({ pub: 'pcpub', kid: 'pckid', sec: 'sec', cid: 'ch-1' });
      expect(result.current.crossCheckCode).toBe('ABCD');
      expect(result.current.channelId).toBe('ch-1');
      expect(result.current.pollToken).toBe('pt-1');
      expect(result.current.expiresAt).toBeInstanceOf(Date);
    });
  });

  describe('start() — provision mode', () => {
    it('calls /api/cloud/qr/initiate (proxy) on start()', async () => {
      mockFetch([
        initiateOk({
          qrPayload: validPayload({ m: 'provision', c: 'WXYZ' }),
          crossCheckCode: 'WXYZ',
          channelId: 'ch-2',
          pollToken: 'pt-2',
        }),
        beginOk,
      ]);

      const { result } = renderHook(() => useQrAuth(IDENTITY_URL, 'provision'));

      await act(async () => {
        await result.current.start();
      });

      expect(global.fetch).toHaveBeenCalledWith(
        '/api/cloud/qr/initiate',
        expect.objectContaining({ method: 'POST' }),
      );
      expect(result.current.status).toBe('waiting');
      expect(result.current.crossCheckCode).toBe('WXYZ');
    });
  });

  describe('start() — error handling', () => {
    it('transitions to error on initiate failure', async () => {
      mockFetch([{ ok: false, status: 500, json: async () => ({}) }]);

      const { result } = renderHook(() => useQrAuth(IDENTITY_URL, 'claim'));

      await act(async () => {
        await result.current.start();
      });

      expect(result.current.status).toBe('error');
      expect(result.current.error).toBe('initiate:500');
    });

    it('transitions to error on network failure', async () => {
      global.fetch = jest.fn(async () => {
        throw new Error('Network error');
      }) as unknown as typeof fetch;

      const { result } = renderHook(() => useQrAuth(IDENTITY_URL, 'claim'));

      await act(async () => {
        await result.current.start();
      });

      expect(result.current.status).toBe('error');
      expect(result.current.error).toBe('Network error');
    });
  });

  describe('start() — fail-closed E2EE (never show a plaintext QR)', () => {
    it('errors and shows NO QR when the E2EE begin endpoint fails', async () => {
      mockFetch([initiateOk(), { ok: false, status: 500, json: async () => ({}) }]);

      const { result } = renderHook(() => useQrAuth(IDENTITY_URL, 'provision'));
      await act(async () => {
        await result.current.start();
      });

      expect(result.current.status).toBe('error');
      expect(result.current.qrPayload).toBeNull(); // never downgraded to a plaintext QR
      expect(result.current.error).toContain('encrypted pairing');
    });

    it('errors when begin returns incomplete key material', async () => {
      mockFetch([initiateOk(), { json: async () => ({ pcEncPubKey: 'pcpub' }) }]);

      const { result } = renderHook(() => useQrAuth(IDENTITY_URL, 'provision'));
      await act(async () => {
        await result.current.start();
      });

      expect(result.current.status).toBe('error');
      expect(result.current.qrPayload).toBeNull();
    });
  });

  describe('polling', () => {
    it('sends X-Poll-Token header on each poll', async () => {
      const { result } = renderHook(() => useQrAuth(IDENTITY_URL, 'claim'));

      mockFetch([initiateOk(), beginOk, { json: async () => ({ status: 'pending' }) }]);

      await act(async () => {
        await result.current.start();
      });

      act(() => {
        jest.advanceTimersByTime(2500);
      });
      await act(async () => {
        await Promise.resolve();
      });

      // After initiate (call 0) + e2ee begin (call 1), the poll is call 2.
      const pollCall = (global.fetch as jest.Mock).mock.calls[2];
      expect(pollCall[0]).toBe(`${IDENTITY_URL}/auth/qr/poll/ch-1`);
      expect(pollCall[1]?.headers).toEqual({ 'X-Poll-Token': 'pt-1' });
    });

    it('transitions to success via finalize on approved (Flow A)', async () => {
      const { result } = renderHook(() => useQrAuth(IDENTITY_URL, 'claim'));

      mockFetch([
        initiateOk(),
        beginOk,
        { json: async () => ({ status: 'approved' }) },
        { json: async () => ({ accessToken: 'at-123', refreshToken: 'rt-456' }) },
      ]);

      await act(async () => {
        await result.current.start();
      });

      act(() => {
        jest.advanceTimersByTime(2500);
      });
      await act(async () => {
        await Promise.resolve();
      });

      expect(result.current.status).toBe('success');
      expect(result.current.tokens).toEqual({ accessToken: 'at-123', refreshToken: 'rt-456' });

      // initiate (0) + e2ee begin (1) + poll (2) + finalize (3)
      const finalizeCall = (global.fetch as jest.Mock).mock.calls[3];
      expect(finalizeCall[0]).toBe(`${IDENTITY_URL}/auth/qr/finalize`);
      expect(finalizeCall[1]?.method).toBe('POST');
      const body = JSON.parse(finalizeCall[1]?.body);
      expect(body).toEqual({ channelId: 'ch-1', pollToken: 'pt-1' });
    });

    it('transitions to success on redeemed (Flow B)', async () => {
      const { result } = renderHook(() => useQrAuth(IDENTITY_URL, 'claim'));

      mockFetch([initiateOk(), beginOk, { json: async () => ({ status: 'redeemed' }) }]);

      await act(async () => {
        await result.current.start();
      });

      act(() => {
        jest.advanceTimersByTime(2500);
      });
      await act(async () => {
        await Promise.resolve();
      });

      expect(result.current.status).toBe('success');
      // No finalize call — initiate + e2ee begin + poll = 3 fetch calls
      expect((global.fetch as jest.Mock).mock.calls.length).toBe(3);
    });

    it('transitions to denied on denied status', async () => {
      const { result } = renderHook(() => useQrAuth(IDENTITY_URL, 'claim'));

      mockFetch([initiateOk(), beginOk, { json: async () => ({ status: 'denied' }) }]);

      await act(async () => {
        await result.current.start();
      });

      act(() => {
        jest.advanceTimersByTime(2500);
      });
      await act(async () => {
        await Promise.resolve();
      });

      expect(result.current.status).toBe('denied');
    });

    it('transitions to expired on expired status', async () => {
      const { result } = renderHook(() => useQrAuth(IDENTITY_URL, 'claim'));

      mockFetch([initiateOk(), beginOk, { json: async () => ({ status: 'expired' }) }]);

      await act(async () => {
        await result.current.start();
      });

      act(() => {
        jest.advanceTimersByTime(2500);
      });
      await act(async () => {
        await Promise.resolve();
      });

      expect(result.current.status).toBe('expired');
    });

    it('stops polling after terminal status', async () => {
      const { result } = renderHook(() => useQrAuth(IDENTITY_URL, 'claim'));

      mockFetch([initiateOk(), beginOk, { json: async () => ({ status: 'expired' }) }]);

      await act(async () => {
        await result.current.start();
      });

      // First poll — expired
      act(() => {
        jest.advanceTimersByTime(2500);
      });
      await act(async () => {
        await Promise.resolve();
      });

      expect(result.current.status).toBe('expired');

      // Second timer tick should NOT trigger another fetch
      const callCount = (global.fetch as jest.Mock).mock.calls.length;
      act(() => {
        jest.advanceTimersByTime(2500);
      });
      await act(async () => {
        await Promise.resolve();
      });

      expect((global.fetch as jest.Mock).mock.calls.length).toBe(callCount);
    });

    it('handles poll failure', async () => {
      const { result } = renderHook(() => useQrAuth(IDENTITY_URL, 'claim'));

      mockFetch([initiateOk(), beginOk, { ok: false, status: 401, json: async () => ({}) }]);

      await act(async () => {
        await result.current.start();
      });

      act(() => {
        jest.advanceTimersByTime(2500);
      });
      await act(async () => {
        await Promise.resolve();
      });

      expect(result.current.status).toBe('error');
      expect(result.current.error).toBe('poll:401');
    });
  });

  describe('cancel()', () => {
    it('clears interval and resets to idle', async () => {
      mockFetch([initiateOk(), beginOk, { json: async () => ({ status: 'pending' }) }]);

      const { result } = renderHook(() => useQrAuth(IDENTITY_URL, 'claim'));

      await act(async () => {
        await result.current.start();
      });
      expect(result.current.status).toBe('waiting');

      act(() => {
        result.current.cancel();
      });

      expect(result.current.status).toBe('idle');
      expect(result.current.qrPayload).toBeNull();

      // Polling should stop — advance timer and verify no new fetch
      const callCount = (global.fetch as jest.Mock).mock.calls.length;
      act(() => {
        jest.advanceTimersByTime(5000);
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect((global.fetch as jest.Mock).mock.calls.length).toBe(callCount);
    });
  });

  describe('retry()', () => {
    it('resets state and calls start() again', async () => {
      // First attempt fails
      mockFetch([{ ok: false, status: 500, json: async () => ({}) }]);

      const { result } = renderHook(() => useQrAuth(IDENTITY_URL, 'claim'));

      await act(async () => {
        await result.current.start();
      });
      expect(result.current.status).toBe('error');

      // Retry succeeds (initiate + e2ee begin)
      mockFetch([
        initiateOk({
          qrPayload: validPayload({ c: 'EFGH' }),
          crossCheckCode: 'EFGH',
          channelId: 'ch-3',
          pollToken: 'pt-3',
        }),
        beginOk,
      ]);

      await act(async () => {
        await result.current.retry();
      });

      expect(result.current.status).toBe('waiting');
      expect(result.current.crossCheckCode).toBe('EFGH');
    });
  });

  describe('unmount cleanup', () => {
    it('stops polling on unmount', async () => {
      mockFetch([initiateOk(), beginOk, { json: async () => ({ status: 'pending' }) }]);

      const { result, unmount } = renderHook(() => useQrAuth(IDENTITY_URL, 'claim'));

      await act(async () => {
        await result.current.start();
      });
      expect(result.current.status).toBe('waiting');

      unmount();

      // Advance timer — no new fetch should happen after unmount
      const callCount = (global.fetch as jest.Mock).mock.calls.length;
      act(() => {
        jest.advanceTimersByTime(5000);
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect((global.fetch as jest.Mock).mock.calls.length).toBe(callCount);
    });
  });

  describe('E2EE QR augmentation + completion (Task:4)', () => {
    it('folds the PC key + pairing secret into the QR via the begin endpoint', async () => {
      mockFetch([initiateOk(), beginOk, { json: async () => ({ status: 'pending' }) }]);

      const { result } = renderHook(() => useQrAuth(IDENTITY_URL, 'provision'));
      await act(async () => {
        await result.current.start();
      });

      expect((global.fetch as jest.Mock).mock.calls[1][0]).toBe('/api/e2ee/pairing/begin');
      const augmented = decode(result.current.qrPayload!);
      expect(augmented.p).toBe('abc'); // original fields preserved
      expect(augmented.e2ee).toEqual({ pub: 'pcpub', kid: 'pckid', sec: 'sec', cid: 'ch-1' });
    });

    it('completes the handshake when the relay returns the device key + MAC', async () => {
      const deviceE2ee = {
        deviceEncPubKey: 'mobpub',
        deviceEncKid: 'mobkid',
        pairingMac: 'themac',
      };
      mockFetch([
        initiateOk(),
        beginOk,
        // poll returns approved WITH relayed device material
        { json: async () => ({ status: 'approved', e2ee: deviceE2ee }) },
        // finalize tokens
        { json: async () => ({ accessToken: 'at', refreshToken: 'rt' }) },
      ]);

      const { result } = renderHook(() => useQrAuth(IDENTITY_URL, 'claim'));
      await act(async () => {
        await result.current.start();
      });
      act(() => {
        jest.advanceTimersByTime(2500);
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      const completeCall = (global.fetch as jest.Mock).mock.calls.find(
        (c) => c[0] === '/api/e2ee/pairing/complete',
      );
      expect(completeCall).toBeDefined();
      expect(JSON.parse(completeCall![1].body)).toEqual({ channelId: 'ch-1', ...deviceE2ee });
    });

    // Phase-1 Task:5 (paired-device-dedup): the renderer spreads `...e2ee` blindly, so an
    // installId relayed by identity-service through the QR channel reaches the complete body
    // (the new-phone → PC installId delivery seam). This is the cross-component half of
    // "new phone + PC: installId carried through" — `completeE2ee` does NOT enumerate fields.
    it('forwards a relayed installId to the complete body via the ...e2ee spread (Task:5)', async () => {
      const deviceE2eeWithInstall = {
        deviceEncPubKey: 'mobpub',
        deviceEncKid: 'mobkid',
        pairingMac: 'themac',
        installId: '11111111-1111-4111-8111-111111111111',
      };
      mockFetch([
        initiateOk(),
        beginOk,
        { json: async () => ({ status: 'approved', e2ee: deviceE2eeWithInstall }) },
        { json: async () => ({ accessToken: 'at', refreshToken: 'rt' }) },
        // completeE2ee also fetches the safety number after a successful complete.
        { ok: true, json: async () => ({ kid: 'mobkid' }) },
        { ok: true, json: async () => ({ safetyNumber: 'sn' }) },
      ]);

      const { result } = renderHook(() => useQrAuth(IDENTITY_URL, 'claim'));
      await act(async () => {
        await result.current.start();
      });
      act(() => {
        jest.advanceTimersByTime(2500);
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      const completeCall = (global.fetch as jest.Mock).mock.calls.find(
        (c) => c[0] === '/api/e2ee/pairing/complete',
      );
      expect(completeCall).toBeDefined();
      // installId rides the spread into the complete body unchanged.
      expect(JSON.parse(completeCall![1].body)).toEqual({
        channelId: 'ch-1',
        ...deviceE2eeWithInstall,
      });
    });
  });

  describe('StrictMode regression', () => {
    it('reaches status=waiting under StrictMode double-invoke', async () => {
      mockFetch([
        initiateOk({
          qrPayload: validPayload({ p: '865217d4' }),
          crossCheckCode: 'FBTT',
          channelId: 'bdc13007-39c7-4968-8e76-6ced78e8cf75',
          pollToken: 'bef4bdbc-poll-token',
        }),
        beginOk,
      ]);

      const { result } = renderHook(() => useQrAuth(IDENTITY_URL, 'provision'), {
        wrapper: ({ children }) => React.createElement(React.StrictMode, null, children),
      });

      await act(async () => {
        await result.current.start();
      });

      await waitFor(() => {
        expect(result.current.status).toBe('waiting');
      });
      const decoded = decode(result.current.qrPayload!);
      expect(decoded.p).toBe('865217d4');
      expect(decoded.e2ee).toEqual({
        pub: 'pcpub',
        kid: 'pckid',
        sec: 'sec',
        cid: 'bdc13007-39c7-4968-8e76-6ced78e8cf75',
      });
      expect(result.current.crossCheckCode).toBe('FBTT');
      expect(result.current.channelId).toBe('bdc13007-39c7-4968-8e76-6ced78e8cf75');
      expect(result.current.pollToken).toBe('bef4bdbc-poll-token');
    });
  });
});

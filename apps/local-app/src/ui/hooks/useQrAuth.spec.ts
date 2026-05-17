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
    it('calls identityServiceUrl/auth/qr/initiate on start()', async () => {
      mockFetch([
        {
          json: async () => ({
            qrPayload: '{"v":1,"p":"abc","u":"http://localhost:3002","c":"ABCD","m":"claim"}',
            crossCheckCode: 'ABCD',
            expiresAt: new Date(Date.now() + 120_000).toISOString(),
            channelId: 'ch-1',
            pollToken: 'pt-1',
          }),
        },
      ]);

      const { result } = renderHook(() => useQrAuth(IDENTITY_URL, 'claim'));

      await act(async () => {
        await result.current.start();
      });

      expect(result.current.status).toBe('waiting');
      expect(global.fetch).toHaveBeenCalledWith(
        `${IDENTITY_URL}/auth/qr/initiate`,
        expect.objectContaining({ method: 'POST' }),
      );
      expect(result.current.qrPayload).toContain('abc');
      expect(result.current.crossCheckCode).toBe('ABCD');
      expect(result.current.channelId).toBe('ch-1');
      expect(result.current.pollToken).toBe('pt-1');
      expect(result.current.expiresAt).toBeInstanceOf(Date);
    });
  });

  describe('start() — provision mode', () => {
    it('calls /api/cloud/qr/initiate (proxy) on start()', async () => {
      mockFetch([
        {
          json: async () => ({
            qrPayload: '{"v":1,"p":"xyz","u":"http://localhost:3002","c":"WXYZ","m":"provision"}',
            crossCheckCode: 'WXYZ',
            expiresAt: new Date(Date.now() + 120_000).toISOString(),
            channelId: 'ch-2',
            pollToken: 'pt-2',
          }),
        },
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

  describe('polling', () => {
    it('sends X-Poll-Token header on each poll', async () => {
      const { result } = renderHook(() => useQrAuth(IDENTITY_URL, 'claim'));

      // initiate
      mockFetch([
        {
          json: async () => ({
            qrPayload: 'qr',
            crossCheckCode: 'ABCD',
            expiresAt: new Date(Date.now() + 120_000).toISOString(),
            channelId: 'ch-1',
            pollToken: 'pt-1',
          }),
        },
        // first poll — still pending
        { json: async () => ({ status: 'pending' }) },
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

      // Second fetch call should be poll with X-Poll-Token header
      const pollCall = (global.fetch as jest.Mock).mock.calls[1];
      expect(pollCall[0]).toBe(`${IDENTITY_URL}/auth/qr/poll/ch-1`);
      expect(pollCall[1]?.headers).toEqual({ 'X-Poll-Token': 'pt-1' });
    });

    it('transitions to success via finalize on approved (Flow A)', async () => {
      const { result } = renderHook(() => useQrAuth(IDENTITY_URL, 'claim'));

      mockFetch([
        // initiate
        {
          json: async () => ({
            qrPayload: 'qr',
            crossCheckCode: 'ABCD',
            expiresAt: new Date(Date.now() + 120_000).toISOString(),
            channelId: 'ch-1',
            pollToken: 'pt-1',
          }),
        },
        // poll returns approved
        { json: async () => ({ status: 'approved' }) },
        // finalize returns tokens
        { json: async () => ({ accessToken: 'at-123', refreshToken: 'rt-456' }) },
      ]);

      await act(async () => {
        await result.current.start();
      });

      // Advance timer to trigger poll
      act(() => {
        jest.advanceTimersByTime(2500);
      });
      await act(async () => {
        await Promise.resolve();
      });

      expect(result.current.status).toBe('success');
      expect(result.current.tokens).toEqual({ accessToken: 'at-123', refreshToken: 'rt-456' });

      // finalize called with correct body
      const finalizeCall = (global.fetch as jest.Mock).mock.calls[2];
      expect(finalizeCall[0]).toBe(`${IDENTITY_URL}/auth/qr/finalize`);
      expect(finalizeCall[1]?.method).toBe('POST');
      const body = JSON.parse(finalizeCall[1]?.body);
      expect(body).toEqual({ channelId: 'ch-1', pollToken: 'pt-1' });
    });

    it('transitions to success on redeemed (Flow B)', async () => {
      const { result } = renderHook(() => useQrAuth(IDENTITY_URL, 'claim'));

      mockFetch([
        {
          json: async () => ({
            qrPayload: 'qr',
            crossCheckCode: 'ABCD',
            expiresAt: new Date(Date.now() + 120_000).toISOString(),
            channelId: 'ch-1',
            pollToken: 'pt-1',
          }),
        },
        // poll returns redeemed
        { json: async () => ({ status: 'redeemed' }) },
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
      // No finalize call — only 2 fetch calls (initiate + poll)
      expect((global.fetch as jest.Mock).mock.calls.length).toBe(2);
    });

    it('transitions to denied on denied status', async () => {
      const { result } = renderHook(() => useQrAuth(IDENTITY_URL, 'claim'));

      mockFetch([
        {
          json: async () => ({
            qrPayload: 'qr',
            crossCheckCode: 'ABCD',
            expiresAt: new Date(Date.now() + 120_000).toISOString(),
            channelId: 'ch-1',
            pollToken: 'pt-1',
          }),
        },
        { json: async () => ({ status: 'denied' }) },
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

      expect(result.current.status).toBe('denied');
    });

    it('transitions to expired on expired status', async () => {
      const { result } = renderHook(() => useQrAuth(IDENTITY_URL, 'claim'));

      mockFetch([
        {
          json: async () => ({
            qrPayload: 'qr',
            crossCheckCode: 'ABCD',
            expiresAt: new Date(Date.now() + 120_000).toISOString(),
            channelId: 'ch-1',
            pollToken: 'pt-1',
          }),
        },
        { json: async () => ({ status: 'expired' }) },
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

      expect(result.current.status).toBe('expired');
    });

    it('stops polling after terminal status', async () => {
      const { result } = renderHook(() => useQrAuth(IDENTITY_URL, 'claim'));

      mockFetch([
        {
          json: async () => ({
            qrPayload: 'qr',
            crossCheckCode: 'ABCD',
            expiresAt: new Date(Date.now() + 120_000).toISOString(),
            channelId: 'ch-1',
            pollToken: 'pt-1',
          }),
        },
        { json: async () => ({ status: 'expired' }) },
      ]);

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

      mockFetch([
        {
          json: async () => ({
            qrPayload: 'qr',
            crossCheckCode: 'ABCD',
            expiresAt: new Date(Date.now() + 120_000).toISOString(),
            channelId: 'ch-1',
            pollToken: 'pt-1',
          }),
        },
        { ok: false, status: 401, json: async () => ({}) },
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

      expect(result.current.status).toBe('error');
      expect(result.current.error).toBe('poll:401');
    });
  });

  describe('cancel()', () => {
    it('clears interval and resets to idle', async () => {
      mockFetch([
        {
          json: async () => ({
            qrPayload: 'qr',
            crossCheckCode: 'ABCD',
            expiresAt: new Date(Date.now() + 120_000).toISOString(),
            channelId: 'ch-1',
            pollToken: 'pt-1',
          }),
        },
        { json: async () => ({ status: 'pending' }) },
      ]);

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

      // Retry succeeds
      mockFetch([
        {
          json: async () => ({
            qrPayload: 'qr-2',
            crossCheckCode: 'EFGH',
            expiresAt: new Date(Date.now() + 120_000).toISOString(),
            channelId: 'ch-3',
            pollToken: 'pt-3',
          }),
        },
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
      mockFetch([
        {
          json: async () => ({
            qrPayload: 'qr',
            crossCheckCode: 'ABCD',
            expiresAt: new Date(Date.now() + 120_000).toISOString(),
            channelId: 'ch-1',
            pollToken: 'pt-1',
          }),
        },
        { json: async () => ({ status: 'pending' }) },
      ]);

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

  describe('StrictMode regression', () => {
    it('reaches status=waiting under StrictMode double-invoke', async () => {
      mockFetch([
        {
          json: async () => ({
            qrPayload: 'eyJ2IjoxLCJwIjoiODY1MjE3ZDQifQ==',
            crossCheckCode: 'FBTT',
            expiresAt: new Date(Date.now() + 120_000).toISOString(),
            channelId: 'bdc13007-39c7-4968-8e76-6ced78e8cf75',
            pollToken: 'bef4bdbc-poll-token',
          }),
        },
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
      expect(result.current.qrPayload).toBe('eyJ2IjoxLCJwIjoiODY1MjE3ZDQifQ==');
      expect(result.current.crossCheckCode).toBe('FBTT');
      expect(result.current.channelId).toBe('bdc13007-39c7-4968-8e76-6ced78e8cf75');
      expect(result.current.pollToken).toBe('bef4bdbc-poll-token');
    });
  });
});

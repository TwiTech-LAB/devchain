/** @jest-environment jsdom */

import { render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { CloudCallbackPage } from './CloudCallbackPage';
import { CLOUD_SIGN_IN_NONCE_STORAGE_KEY, CLOUD_TARGET_STORAGE_KEY } from '@/ui/lib/cloud-target';

const mockFetch = jest.fn();
const NONCE = '0123456789abcdef0123456789abcdef';
const NOW = 1_800_000_000_000;
const NONCE_TTL = 20 * 60 * 1000;

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function renderCallback(
  nonce: string | null = NONCE,
  fragment = '#access_token=at-123&refresh_token=rt-456',
) {
  const query = nonce === null ? '' : `?nonce=${nonce}`;
  window.history.replaceState(null, '', `/auth/cloud/callback${query}${fragment}`);
  return render(
    <StrictMode>
      <CloudCallbackPage />
    </StrictMode>,
  );
}

// The component is the cheapest layer that verifies nonce refusal prevents token HTTP requests.
describe('CloudCallbackPage', () => {
  beforeEach(() => {
    window.localStorage.clear();
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
    window.localStorage.setItem(
      CLOUD_SIGN_IN_NONCE_STORAGE_KEY,
      JSON.stringify({ nonce: NONCE, createdAt: NOW }),
    );
    global.fetch = mockFetch;
    mockFetch.mockReset();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    window.history.replaceState(null, '', '/');
  });

  it.each([0, NONCE_TTL - 1])(
    'hands tokens to home for a matching nonce aged %i ms',
    async (age) => {
      window.localStorage.setItem(
        CLOUD_SIGN_IN_NONCE_STORAGE_KEY,
        JSON.stringify({ nonce: NONCE, createdAt: NOW - age }),
      );
      window.localStorage.setItem(
        CLOUD_TARGET_STORAGE_KEY,
        JSON.stringify({ backend: 'home', remoteName: null }),
      );
      mockFetch.mockResolvedValue(jsonResponse({ userId: 'u1', email: 'e@x.com' }));

      renderCallback();

      await waitFor(() => expect(screen.getByText('Connected to cloud')).toBeInTheDocument());
      const urls = mockFetch.mock.calls.map((call) => String(call[0]));
      expect(urls).toEqual(['/api/auth/cloud/tokens']);
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/auth/cloud/tokens',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ accessToken: 'at-123', refreshToken: 'rt-456' }),
        }),
      );
      expect(window.localStorage.getItem(CLOUD_SIGN_IN_NONCE_STORAGE_KEY)).toBeNull();
      expect(window.location.hash).toBe('');
    },
  );

  it.each([null, 'wrong-nonce'])(
    'refuses nonce %s without cancelling the pending sign-in',
    (nonce) => {
      const stored = window.localStorage.getItem(CLOUD_SIGN_IN_NONCE_STORAGE_KEY);

      renderCallback(nonce);

      expect(screen.getByText('Start sign-in again from DevChain')).toBeInTheDocument();
      expect(mockFetch).not.toHaveBeenCalled();
      expect(window.localStorage.getItem(CLOUD_SIGN_IN_NONCE_STORAGE_KEY)).toBe(stored);
      expect(window.location.hash).toBe('');
    },
  );

  it.each([NONCE, 'wrong-nonce', null])(
    'deletes an expired nonce when the callback has %s',
    (nonce) => {
      window.localStorage.setItem(
        CLOUD_SIGN_IN_NONCE_STORAGE_KEY,
        JSON.stringify({ nonce: NONCE, createdAt: NOW - NONCE_TTL }),
      );

      renderCallback(nonce);

      expect(screen.getByText('Start sign-in again from DevChain')).toBeInTheDocument();
      expect(mockFetch).not.toHaveBeenCalled();
      expect(window.localStorage.getItem(CLOUD_SIGN_IN_NONCE_STORAGE_KEY)).toBeNull();
      expect(window.location.hash).toBe('');
    },
  );

  it.each([
    null,
    '{',
    'null',
    JSON.stringify({ nonce: NONCE }),
    JSON.stringify({ nonce: NONCE, createdAt: NOW + 1 }),
  ])('refuses missing or invalid stored nonce data: %s', (stored) => {
    if (stored === null) window.localStorage.removeItem(CLOUD_SIGN_IN_NONCE_STORAGE_KEY);
    else window.localStorage.setItem(CLOUD_SIGN_IN_NONCE_STORAGE_KEY, stored);

    renderCallback();

    expect(screen.getByText('Start sign-in again from DevChain')).toBeInTheDocument();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(window.location.hash).toBe('');
  });

  it('refuses a replay after the matching nonce is consumed', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ userId: 'u1' }));
    const first = renderCallback();
    await waitFor(() => expect(screen.getByText('Connected to cloud')).toBeInTheDocument());
    first.unmount();
    mockFetch.mockClear();

    renderCallback();

    expect(screen.getByText('Start sign-in again from DevChain')).toBeInTheDocument();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(window.location.hash).toBe('');
  });

  it.each(['getItem', 'removeItem'] as const)(
    'refuses tokens when nonce storage %s fails',
    (method) => {
      const stored = window.localStorage.getItem(CLOUD_SIGN_IN_NONCE_STORAGE_KEY);
      const storage = jest.spyOn(Storage.prototype, method).mockImplementation(() => {
        throw new Error('Storage unavailable');
      });

      renderCallback();

      expect(screen.getByText('Start sign-in again from DevChain')).toBeInTheDocument();
      expect(mockFetch).not.toHaveBeenCalled();
      expect(window.location.hash).toBe('');
      storage.mockRestore();
      expect(window.localStorage.getItem(CLOUD_SIGN_IN_NONCE_STORAGE_KEY)).toBe(stored);
    },
  );

  it.each([
    ['', 'No authentication data received.'],
    ['#access_token=at-123', 'Missing authentication tokens.'],
    ['#access_token=%&refresh_token=rt-456', 'Invalid authentication data.'],
  ])('clears the fragment when token data is invalid: %s', (fragment, error) => {
    renderCallback(NONCE, fragment);

    expect(screen.getByText(error)).toBeInTheDocument();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(window.location.hash).toBe('');
  });

  it('pushes the remote label first, then hands tokens to the remote through the proxy', async () => {
    window.localStorage.setItem(
      CLOUD_TARGET_STORAGE_KEY,
      JSON.stringify({ backend: 'r-1', remoteName: 'stale-name' }),
    );
    mockFetch.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/remotes') {
        return jsonResponse({ items: [{ id: 'r-1', name: 'lab-vm' }] });
      }
      return jsonResponse({ userId: 'u1', email: 'e@x.com' });
    });

    renderCallback();

    await waitFor(() =>
      expect(mockFetch).toHaveBeenCalledWith('/r/r-1/api/auth/cloud/tokens', expect.anything()),
    );
    const calls = mockFetch.mock.calls.map((call) => String(call[0]));
    // The fresh name from home's remotes list is what becomes the instance label.
    expect(calls.indexOf('/r/r-1/api/cloud/instance-label')).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf('/api/remotes')).toBeLessThan(
      calls.indexOf('/r/r-1/api/cloud/instance-label'),
    );
    expect(calls.indexOf('/r/r-1/api/cloud/instance-label')).toBeLessThan(
      calls.indexOf('/r/r-1/api/auth/cloud/tokens'),
    );
    const labelCall = mockFetch.mock.calls.find(
      (call) => String(call[0]) === '/r/r-1/api/cloud/instance-label',
    );
    expect(JSON.parse((labelCall![1] as RequestInit).body as string)).toEqual({
      label: 'lab-vm',
    });
  });

  it('still completes sign-in when the label push fails', async () => {
    window.localStorage.setItem(
      CLOUD_TARGET_STORAGE_KEY,
      JSON.stringify({ backend: 'r-1', remoteName: 'lab-vm' }),
    );
    mockFetch.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/r/r-1/api/cloud/instance-label') {
        throw new Error('proxy unreachable');
      }
      if (url === '/api/remotes') {
        return jsonResponse({ items: [] });
      }
      return jsonResponse({ userId: 'u1', email: 'e@x.com' });
    });

    renderCallback();

    await waitFor(() =>
      expect(mockFetch).toHaveBeenCalledWith('/r/r-1/api/auth/cloud/tokens', expect.anything()),
    );
  });

  it('shows the failure state when the token hand-off is rejected', async () => {
    window.localStorage.setItem(
      CLOUD_TARGET_STORAGE_KEY,
      JSON.stringify({ backend: 'home', remoteName: null }),
    );
    mockFetch.mockResolvedValue(jsonResponse({ message: 'invalid token' }, 400));

    renderCallback();

    await waitFor(() =>
      expect(mockFetch).toHaveBeenCalledWith('/api/auth/cloud/tokens', expect.anything()),
    );
    await waitFor(() => expect(screen.getByText('invalid token')).toBeInTheDocument());
    expect(window.location.hash).toBe('');
  });
});

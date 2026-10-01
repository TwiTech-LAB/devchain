/** @jest-environment jsdom */

import { render, screen, waitFor } from '@testing-library/react';
import { CloudCallbackPage } from './CloudCallbackPage';
import { CLOUD_TARGET_STORAGE_KEY } from '@/ui/lib/cloud-target';

const mockFetch = jest.fn();

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function renderCallback() {
  window.location.hash = '#access_token=at-123&refresh_token=rt-456';
  const utils = render(<CloudCallbackPage />);
  // The page strips the fragment once it has read the tokens.
  window.location.hash = '';
  return utils;
}

describe('CloudCallbackPage', () => {
  beforeEach(() => {
    window.localStorage.clear();
    global.fetch = mockFetch;
    mockFetch.mockReset();
  });

  it('hands tokens to home directly when This PC is selected', async () => {
    window.localStorage.setItem(
      CLOUD_TARGET_STORAGE_KEY,
      JSON.stringify({ backend: 'home', remoteName: null }),
    );
    mockFetch.mockResolvedValue(jsonResponse({ userId: 'u1', email: 'e@x.com' }));

    renderCallback();

    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    const urls = mockFetch.mock.calls.map((call) => String(call[0]));
    expect(urls).toEqual(['/api/auth/cloud/tokens']);
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
  });
});

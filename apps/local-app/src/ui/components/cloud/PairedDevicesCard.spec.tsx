/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PairedDevicesCard } from './PairedDevicesCard';

const originalFetch = global.fetch;

/**
 * Route a fake fetch by URL substring. Patterns are tried in insertion order, so the
 * more specific `/safety-number` MUST be listed before `/api/e2ee/devices` (the
 * safety-number URL also contains `/api/e2ee/devices`).
 */
function mockFetch(handlers: Array<[string, unknown]>) {
  return jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    for (const [pattern, body] of handlers) {
      if (url.includes(pattern)) {
        return { ok: true, status: 200, json: async () => body } as Response;
      }
    }
    return { ok: false, status: 404, json: async () => ({}) } as Response;
  });
}

const device = (over: Record<string, unknown> = {}) => ({
  kid: 'k1',
  label: 'Pixel',
  trust: 'unverified',
  addedAt: '2026-06-20T00:00:00Z',
  ...over,
});

describe('PairedDevicesCard', () => {
  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('lists paired devices with a trust badge', async () => {
    global.fetch = mockFetch([['/api/e2ee/devices', [device()]]]) as unknown as typeof fetch;

    render(<PairedDevicesCard />);

    expect(await screen.findByText('Pixel')).toBeInTheDocument();
    expect(screen.getByText('Trusted on first use')).toBeInTheDocument();
  });

  it('labels a QR-verified device as Verified', async () => {
    global.fetch = mockFetch([
      ['/api/e2ee/devices', [device({ label: 'iPhone', trust: 'verified', verifiedVia: 'qr' })]],
    ]) as unknown as typeof fetch;

    render(<PairedDevicesCard />);
    expect(await screen.findByText('iPhone')).toBeInTheDocument();
    expect(screen.getByText('Verified')).toBeInTheDocument();
  });

  it('reveals the safety number on demand and hides it again', async () => {
    global.fetch = mockFetch([
      [
        '/safety-number',
        { kid: 'k1', safetyNumber: '11111 22222 33333 44444', trust: 'unverified' },
      ],
      ['/api/e2ee/devices', [device()]],
    ]) as unknown as typeof fetch;

    render(<PairedDevicesCard />);
    const showBtn = await screen.findByRole('button', { name: /show safety number/i });

    fireEvent.click(showBtn);
    expect(await screen.findByTestId('device-safety-number')).toHaveTextContent(
      '11111 22222 33333 44444',
    );

    fireEvent.click(screen.getByRole('button', { name: /hide/i }));
    await waitFor(() =>
      expect(screen.queryByTestId('device-safety-number')).not.toBeInTheDocument(),
    );
  });

  it('un-pairs a device after confirmation and reloads the list', async () => {
    let list: unknown[] = [device()];
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'DELETE') {
        list = [];
        return {
          ok: true,
          status: 200,
          json: async () => ({ kid: 'k1', removed: true }),
        } as Response;
      }
      if (url.includes('/api/e2ee/devices')) {
        return { ok: true, status: 200, json: async () => list } as Response;
      }
      return { ok: false, status: 404, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;

    render(<PairedDevicesCard />);

    // Row action opens the destructive confirm dialog.
    fireEvent.click(await screen.findByRole('button', { name: /un-pair pixel/i }));
    // The dialog's confirm button (exact "Un-pair", not the row's "Un-pair Pixel").
    fireEvent.click(await screen.findByRole('button', { name: 'Un-pair' }));

    // DELETE fired and the list reloaded empty.
    expect(await screen.findByText(/no devices paired yet/i)).toBeInTheDocument();
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/e2ee/devices/k1'),
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('shows an empty state when no devices are paired', async () => {
    global.fetch = mockFetch([['/api/e2ee/devices', []]]) as unknown as typeof fetch;
    render(<PairedDevicesCard />);
    expect(await screen.findByText(/no devices paired yet/i)).toBeInTheDocument();
  });
});

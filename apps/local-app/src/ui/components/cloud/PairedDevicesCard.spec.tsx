/** @jest-environment jsdom */

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
    if (url.endsWith('/api/workspaces')) {
      return {
        ok: true,
        status: 200,
        json: async () => [{ id: 'w1', name: 'Default', isDefault: true }],
      } as Response;
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

  it.each([
    { label: 'trust on first use', overrides: {}, name: 'Pixel', badge: 'Trusted on first use' },
    {
      label: 'QR verified',
      overrides: { label: 'iPhone', trust: 'verified', verifiedVia: 'qr' },
      name: 'iPhone',
      badge: 'Verified',
    },
  ] as const)('$label', async ({ overrides, name, badge }) => {
    global.fetch = mockFetch([
      ['/api/e2ee/devices', [device(overrides)]],
    ]) as unknown as typeof fetch;
    render(<PairedDevicesCard />);
    expect(await screen.findByText(name)).toBeInTheDocument();
    expect(screen.getByText(badge)).toBeInTheDocument();
  });

  it('uses alias, reported label, and fallback precedence across the row and un-pair dialog', async () => {
    global.fetch = mockFetch([
      [
        '/api/e2ee/devices',
        [
          device({ localAlias: 'Personal phone' }),
          device({ kid: 'k2', label: 'iPhone' }),
          device({ kid: 'k3', label: undefined }),
        ],
      ],
    ]) as unknown as typeof fetch;

    render(<PairedDevicesCard />);

    const aliased = await screen.findByTestId('paired-device-k1');
    expect(within(aliased).getByRole('button', { name: 'Rename Personal phone' })).toBeVisible();
    expect(within(aliased).getByText('Reported name: Pixel')).toBeVisible();
    expect(
      within(screen.getByTestId('paired-device-k2')).getByRole('button', {
        name: 'Rename iPhone',
      }),
    ).toBeVisible();
    expect(
      within(screen.getByTestId('paired-device-k3')).getByRole('button', {
        name: 'Rename Mobile device',
      }),
    ).toBeVisible();

    fireEvent.click(within(aliased).getByRole('button', { name: 'Un-pair Personal phone' }));
    expect(screen.getByText(/Remove "Personal phone" from your paired devices/)).toBeVisible();
    expect(screen.getAllByText('Reported name: Pixel')).toHaveLength(2);
  });

  it('focuses and selects the alias input, then shows pending state and commits with Enter', async () => {
    let resolvePatch!: (response: Response) => void;
    const patchResponse = new Promise<Response>((resolve) => {
      resolvePatch = resolve;
    });
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'PATCH') return patchResponse;
      if (url.endsWith('/api/e2ee/devices')) {
        return {
          ok: true,
          status: 200,
          json: async () => [device({ localAlias: 'Personal' })],
        } as Response;
      }
      if (url.endsWith('/api/workspaces')) {
        return {
          ok: true,
          status: 200,
          json: async () => [{ id: 'w1', name: 'Default', isDefault: true }],
        } as Response;
      }
      return { ok: false, status: 404, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;

    render(<PairedDevicesCard />);
    fireEvent.click(await screen.findByRole('button', { name: 'Rename Personal' }));
    const input = screen.getByRole('textbox', { name: 'Local alias for Personal' });
    expect(input).toHaveFocus();
    expect(input).toHaveValue('Personal');
    expect((input as HTMLInputElement).selectionStart).toBe(0);
    expect((input as HTMLInputElement).selectionEnd).toBe('Personal'.length);

    fireEvent.change(input, { target: { value: '  Work phone  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByText('Saving…')).toBeVisible();
    expect(input).toBeDisabled();
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/e2ee/devices/k1',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ localAlias: 'Work phone' }),
      }),
    );

    await act(async () => {
      resolvePatch({
        ok: true,
        status: 200,
        json: async () => device({ localAlias: 'Work phone' }),
      } as Response);
      await patchResponse;
    });
    expect(await screen.findByRole('button', { name: 'Rename Work phone' })).toBeVisible();
    expect(screen.getByText('Reported name: Pixel')).toBeVisible();
    expect(
      (global.fetch as jest.Mock).mock.calls.filter(([, init]) => init?.method === 'PATCH'),
    ).toHaveLength(1);
  });

  it('cancels alias editing with Escape without sending a PATCH', async () => {
    global.fetch = mockFetch([
      ['/api/e2ee/devices', [device({ localAlias: 'Personal' })]],
    ]) as unknown as typeof fetch;
    render(<PairedDevicesCard />);

    fireEvent.click(await screen.findByRole('button', { name: 'Rename Personal' }));
    const input = screen.getByRole('textbox', { name: 'Local alias for Personal' });
    fireEvent.change(input, { target: { value: 'Ignored' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(screen.getByRole('button', { name: 'Rename Personal' })).toBeVisible();
    expect(global.fetch).not.toHaveBeenCalledWith(
      expect.stringContaining('/api/e2ee/devices/k1'),
      expect.objectContaining({ method: 'PATCH' }),
    );
  });

  it('clears on blur, reveals the returned label without refetching, and preserves workspaces', async () => {
    const workspaces = [
      { id: 'w1', name: 'Default', isDefault: true },
      { id: 'w2', name: 'Labs', isDefault: false },
    ];
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'PATCH') {
        return { ok: true, status: 200, json: async () => device() } as Response;
      }
      if (url.endsWith('/api/workspaces')) {
        return { ok: true, status: 200, json: async () => workspaces } as Response;
      }
      if (url.endsWith('/api/e2ee/devices')) {
        return {
          ok: true,
          status: 200,
          json: async () => [device({ localAlias: 'Personal' })],
        } as Response;
      }
      if (url.endsWith('/k1/workspaces')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ workspaceIds: ['w2'], explicit: true }),
        } as Response;
      }
      return { ok: false, status: 404, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;

    render(<PairedDevicesCard />);
    const row = await screen.findByTestId('paired-device-k1');
    expect(within(row).getByRole('checkbox', { name: 'Labs' })).toBeChecked();
    fireEvent.click(within(row).getByRole('button', { name: 'Rename Personal' }));
    const input = within(row).getByRole('textbox', { name: 'Local alias for Personal' });
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.blur(input);

    expect(await within(row).findByRole('button', { name: 'Rename Pixel' })).toBeVisible();
    expect(within(row).queryByText('Reported name: Pixel')).not.toBeInTheDocument();
    expect(within(row).getByRole('checkbox', { name: 'Labs' })).toBeChecked();
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/e2ee/devices/k1',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ localAlias: null }),
      }),
    );
    expect(
      (global.fetch as jest.Mock).mock.calls.filter(
        ([url, init]) => String(url).endsWith('/api/e2ee/devices') && init === undefined,
      ),
    ).toHaveLength(1);
  });

  it('keeps the editor open and shows an accessible error when rename fails', async () => {
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'PATCH') {
        return { ok: false, status: 500, json: async () => ({}) } as Response;
      }
      if (url.endsWith('/api/e2ee/devices')) {
        return { ok: true, status: 200, json: async () => [device()] } as Response;
      }
      if (url.endsWith('/api/workspaces')) {
        return {
          ok: true,
          status: 200,
          json: async () => [{ id: 'w1', name: 'Default', isDefault: true }],
        } as Response;
      }
      return { ok: false, status: 404, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;

    render(<PairedDevicesCard />);
    fireEvent.click(await screen.findByRole('button', { name: 'Rename Pixel' }));
    const input = screen.getByRole('textbox', { name: 'Local alias for Pixel' });
    fireEvent.change(input, { target: { value: 'Broken' } });
    fireEvent.blur(input);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Couldn’t update the local alias for this device.',
    );
    expect(screen.getByRole('textbox', { name: 'Local alias for Pixel' })).toBeEnabled();
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
      if (url.endsWith('/api/workspaces')) {
        return {
          ok: true,
          status: 200,
          json: async () => [{ id: 'w1', name: 'Default', isDefault: true }],
        } as Response;
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

  it('hides workspace grant controls when only one workspace exists', async () => {
    global.fetch = mockFetch([['/api/e2ee/devices', [device()]]]) as unknown as typeof fetch;
    render(<PairedDevicesCard />);

    expect(await screen.findByText('Pixel')).toBeInTheDocument();
    expect(screen.queryByText('Workspace access')).not.toBeInTheDocument();
    expect(global.fetch).not.toHaveBeenCalledWith(expect.stringContaining('/k1/workspaces'));
  });

  it('renders inverse subsets and lets Default be unchecked after selecting W2', async () => {
    const workspaces = [
      { id: '11111111-1111-4111-8111-111111111111', name: 'Default', isDefault: true },
      { id: '22222222-2222-4222-8222-222222222222', name: 'W2', isDefault: false },
    ];
    const access: Record<string, string[]> = {
      k1: [workspaces[0].id],
      k2: [workspaces[1].id],
    };
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/workspaces')) {
        return { ok: true, status: 200, json: async () => workspaces } as Response;
      }
      if (url.endsWith('/api/e2ee/devices')) {
        return {
          ok: true,
          status: 200,
          json: async () => [device(), device({ kid: 'k2', label: 'iPhone' })],
        } as Response;
      }
      const kid = url.includes('/k2/') ? 'k2' : 'k1';
      if (url.includes('/workspaces') && init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as { workspaceIds: string[] };
        access[kid] = body.workspaceIds;
        return {
          ok: true,
          status: 200,
          json: async () => ({ kid, explicit: true, workspaceIds: access[kid] }),
        } as Response;
      }
      if (url.includes('/workspaces')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ kid, explicit: true, workspaceIds: access[kid] }),
        } as Response;
      }
      return { ok: false, status: 404, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;

    render(<PairedDevicesCard />);
    const pixel = await screen.findByTestId('paired-device-k1');
    const iphone = screen.getByTestId('paired-device-k2');
    expect(within(pixel).getByRole('checkbox', { name: 'Default (Default)' })).toBeChecked();
    expect(within(pixel).getByRole('checkbox', { name: 'W2' })).not.toBeChecked();
    expect(within(iphone).getByRole('checkbox', { name: 'Default (Default)' })).not.toBeChecked();
    expect(within(iphone).getByRole('checkbox', { name: 'W2' })).toBeChecked();

    fireEvent.click(within(pixel).getByRole('checkbox', { name: 'W2' }));
    await waitFor(() => expect(within(pixel).getByRole('checkbox', { name: 'W2' })).toBeChecked());
    fireEvent.click(within(pixel).getByRole('checkbox', { name: 'Default (Default)' }));
    await waitFor(() =>
      expect(within(pixel).getByRole('checkbox', { name: 'Default (Default)' })).not.toBeChecked(),
    );
    expect(access.k1).toEqual([workspaces[1].id]);
  });
});

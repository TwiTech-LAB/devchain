import { act, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { useUnsignedDeviceNotice } from './useUnsignedDeviceNotice';
import { useCloudTarget } from './useCloudTarget';
import { ToastHost } from '@/ui/components/shared/ToastHost';
import { CLOUD_TARGET_STORAGE_KEY } from '@/ui/lib/cloud-target';
import { getAppSocket, type WsEnvelope } from '@/ui/lib/socket';

const mockHomeListeners = new Set<(envelope: WsEnvelope) => void>();
const mockRemoteListeners = new Set<(envelope: WsEnvelope) => void>();

jest.mock('@/ui/lib/socket', () => ({
  getAppSocket: jest.fn((backend: string) => {
    const listeners = backend === 'home' ? mockHomeListeners : mockRemoteListeners;
    return {
      on: (event: string, handler: (envelope: WsEnvelope) => void) => {
        if (event === 'message') listeners.add(handler);
      },
      off: (event: string, handler: (envelope: WsEnvelope) => void) => {
        if (event === 'message') listeners.delete(handler);
      },
    };
  }),
  releaseAppSocket: jest.fn(),
}));

jest.mock('@/ui/lib/backend-context', () => ({
  useOptionalBackend: () => ({ ready: true, activeBackend: 'remote-1' }),
}));

jest.mock('./useRemotes', () => ({
  useRemotes: () => ({
    remotes: [{ id: 'remote-1', name: 'Remote PC', online: true, versionMatches: true }],
  }),
}));

// Hook integration retains real dispatch, toast rendering, routing and Account target state.
// Only socket I/O and the remote catalog are faked to reproduce a remote project being active.
function NoticeHarness() {
  useUnsignedDeviceNotice();
  const target = useCloudTarget();
  const location = useLocation();
  return (
    <>
      <output data-testid="account-target">{target.backend}</output>
      <output data-testid="location">
        {location.pathname}
        {location.search}
      </output>
    </>
  );
}

afterEach(() => {
  window.localStorage.removeItem(CLOUD_TARGET_STORAGE_KEY);
});

it('shows the home event toast and opens this PC Account while a remote project and Account target are selected', async () => {
  window.localStorage.setItem(
    CLOUD_TARGET_STORAGE_KEY,
    JSON.stringify({ backend: 'remote-1', remoteName: 'Remote PC' }),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rendered = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/chat']}>
        <ToastHost>
          <NoticeHarness />
        </ToastHost>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  expect(screen.getByTestId('account-target')).toHaveTextContent('remote-1');
  expect(getAppSocket).toHaveBeenCalledWith('home');
  expect(mockRemoteListeners.size).toBe(0);

  act(() => {
    for (const listener of mockHomeListeners) {
      listener({
        topic: 'cloud',
        type: 'e2ee_unsigned_device_added',
        payload: { kid: 'phone-kid', label: 'Pixel' },
      } as WsEnvelope);
    }
  });

  expect(
    await screen.findByText(
      'A phone was added without a signed enrollment: Pixel. Review it in Account → Paired devices.',
    ),
  ).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Review devices' }));
  expect(screen.getByTestId('location')).toHaveTextContent('/cloud?section=account');
  expect(screen.getByTestId('account-target')).toHaveTextContent('home');
  expect(JSON.parse(window.localStorage.getItem(CLOUD_TARGET_STORAGE_KEY)!)).toEqual({
    backend: 'home',
    remoteName: null,
  });

  rendered.unmount();
  client.clear();
  expect(mockHomeListeners.size).toBe(0);
});

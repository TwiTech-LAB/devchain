import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HostInstallRetryForm } from './SshCredentialForms';
import { apiFetch } from '@/ui/lib/api-transport';

jest.mock('@/ui/lib/api-transport', () => ({
  HOME_BACKEND: 'home',
  apiFetch: jest.fn(),
}));

const mockApiFetch = jest.mocked(apiFetch);

function response(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

// Component coverage verifies endpoint values and the submitted credential payload together.
describe('HostInstallRetryForm locked identity', () => {
  it.each(['/Users/actual-user', '/var/home/custom-location'])(
    'shows the endpoint identity verbatim and submits only SSH credentials (%s)',
    async (homePath) => {
      mockApiFetch.mockImplementation(async (path) =>
        path === '/api/remotes/host-install/identity'
          ? response({ user: 'actual-user', homePath })
          : response({ available: false, reason: 'non_loopback_host' }),
      );
      const onRetry = jest.fn();
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      render(
        <QueryClientProvider client={client}>
          <HostInstallRetryForm pending={false} onRetry={onRetry} />
        </QueryClientProvider>,
      );
      const user = userEvent.setup();
      await waitFor(() =>
        expect(screen.getByLabelText('Linux user')).toHaveTextContent('actual-user'),
      );
      expect(screen.getByLabelText('Home folder')).toHaveTextContent(homePath);
      expect(screen.queryByRole('textbox', { name: 'Linux user' })).not.toBeInTheDocument();
      await user.type(screen.getByLabelText('SSH user'), 'ubuntu');
      await user.type(screen.getByLabelText('SSH password'), 'password');
      await user.click(screen.getByRole('button', { name: 'Retry' }));
      expect(onRetry).toHaveBeenCalledTimes(1);
      expect(onRetry).toHaveBeenCalledWith({ user: 'ubuntu', password: 'password' });
    },
  );
});

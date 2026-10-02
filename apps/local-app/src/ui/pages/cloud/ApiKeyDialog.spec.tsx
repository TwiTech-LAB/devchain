import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiKeyDialog } from './ApiKeyDialog';

const homeFetch = jest.fn();
const invalidateQueries = jest.fn();
jest.mock('@/ui/hooks/useFetchFactory', () => ({ useHomeFetch: () => homeFetch }));
jest.mock('@/ui/components/BackendBoundary', () => ({
  useHomeQueryClient: () => ({ invalidateQueries }),
}));
const key = `dck_${'a'.repeat(43)}`;

// Component tests verify write-only input, home routing, error text and close/reset behavior.
describe('ApiKeyDialog', () => {
  beforeEach(() => jest.clearAllMocks());
  it('starts with an empty secret and submits it to home before closing', async () => {
    homeFetch.mockResolvedValue({ ok: true, status: 204 });
    const onClose = jest.fn();
    render(<ApiKeyDialog remoteId="vm" name="lab" mode="enter" onClose={onClose} />);
    const field = screen.getByLabelText('API key');
    expect(field).toHaveValue('');
    expect(field).toHaveAttribute('type', 'password');
    expect(screen.getByText('devchain host api-key reset')).toBeInTheDocument();
    await userEvent.type(field, key);
    await userEvent.click(screen.getByRole('button', { name: 'Check and save' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(homeFetch).toHaveBeenCalledWith(
      '/api/remotes/vm/api-key',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ apiKey: key }) }),
    );
    expect(field).toHaveValue('');
    expect(invalidateQueries).toHaveBeenCalled();
  });

  it('shows the refusal without closing', async () => {
    homeFetch.mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ message: 'The VM refused this key.' }),
    });
    const onClose = jest.fn();
    render(<ApiKeyDialog remoteId="vm" name="lab" mode="enter" onClose={onClose} />);
    await userEvent.type(screen.getByLabelText('API key'), key);
    await userEvent.click(screen.getByRole('button', { name: 'Check and save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The VM refused this key.');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('resets through home without requesting or displaying a stored key', async () => {
    homeFetch.mockResolvedValue({ ok: true, status: 204 });
    const onClose = jest.fn();
    render(<ApiKeyDialog remoteId="vm" name="lab" mode="reset" onClose={onClose} />);
    expect(screen.queryByLabelText('API key')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Reset API key' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(homeFetch).toHaveBeenCalledWith(
      '/api/remotes/vm/api-key/reset',
      expect.objectContaining({ method: 'POST', body: '{}' }),
    );
  });

  it('spins the submit button only while the request runs', async () => {
    let release!: () => void;
    homeFetch.mockReturnValue(
      new Promise((resolve) => {
        release = () => resolve({ ok: true, status: 204 } as Response);
      }),
    );
    const onClose = jest.fn();
    render(<ApiKeyDialog remoteId="vm" name="lab" mode="reset" onClose={onClose} />);

    const submit = screen.getByRole('button', { name: 'Reset API key' });
    expect(submit.querySelector('svg')).toBeNull();
    await userEvent.click(submit);

    const saving = screen.getByRole('button', { name: 'Saving…' });
    expect(saving).toBeDisabled();
    expect(saving.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    expect(cancel).toBeDisabled();
    expect(cancel.querySelector('svg')).toBeNull();

    await act(async () => release());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});

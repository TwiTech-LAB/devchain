import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SessionApiError } from '@/ui/lib/http-json';
import {
  confirmVaultRecoveryCode,
  fetchVaultStatus,
  setupVault,
  unlockVault,
  type VaultStatus,
} from '@/ui/lib/vault';
import { VaultSection } from './VaultSection';

jest.mock('@/ui/lib/vault', () => ({
  ...jest.requireActual('@/ui/lib/vault'),
  fetchVaultStatus: jest.fn(),
  setupVault: jest.fn(),
  unlockVault: jest.fn(),
  confirmVaultRecoveryCode: jest.fn(),
}));

const fetchStatus = fetchVaultStatus as jest.MockedFunction<typeof fetchVaultStatus>;
const setup = setupVault as jest.MockedFunction<typeof setupVault>;
const unlock = unlockVault as jest.MockedFunction<typeof unlockVault>;
const confirm = confirmVaultRecoveryCode as jest.MockedFunction<typeof confirmVaultRecoveryCode>;

const CODE = 'ABCD-EFGH-IJKL-MNOP';

function status(overrides: Partial<VaultStatus> = {}): VaultStatus {
  return {
    state: 'unlocked',
    protection: 'keystore',
    reason: null,
    keystoreAvailable: true,
    recoveryCodePending: false,
    runtime: { protection: 'memory', lingerHint: false },
    ...overrides,
  };
}

function renderSection() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <VaultSection />
    </QueryClientProvider>,
  );
}

describe('VaultSection', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('shows a pending recovery code until the user confirms it', async () => {
    fetchStatus.mockResolvedValue(status({ recoveryCodePending: true, recoveryCode: CODE }));
    confirm.mockResolvedValue(status());
    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    renderSection();

    expect(await screen.findByLabelText('Recovery code')).toHaveTextContent(CODE);
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(CODE));

    fireEvent.click(screen.getByRole('button', { name: 'I saved it' }));

    await waitFor(() => expect(screen.queryByLabelText('Recovery code')).not.toBeInTheDocument());
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(CODE)).not.toBeInTheDocument();
  });

  it.each([
    ['recovery', 'Use recovery code'],
    ['file', 'Use key file'],
  ] as const)('sets up with the %s mode when not set up', async (mode, buttonName) => {
    fetchStatus.mockResolvedValue(
      status({ state: 'not_set_up', protection: null, reason: 'keystore_unavailable' }),
    );
    setup.mockResolvedValue(
      status({
        protection: mode,
        recoveryCodePending: true,
        recoveryCode: CODE,
        runtime: undefined,
      }),
    );

    renderSection();

    fireEvent.click(await screen.findByRole('button', { name: buttonName }));

    await waitFor(() => expect(setup).toHaveBeenCalledWith(mode));
    expect(await screen.findByLabelText('Recovery code')).toHaveTextContent(CODE);
    expect(screen.queryByRole('button', { name: buttonName })).not.toBeInTheDocument();
    // The runtime badge from the status route survives the setup response.
    expect(screen.getByText('Runtime files: memory')).toBeInTheDocument();
  });

  it('unlocks with a correct recovery code', async () => {
    fetchStatus.mockResolvedValue(
      status({ state: 'locked', protection: 'recovery', reason: 'recovery_required' }),
    );
    unlock.mockResolvedValue(status({ protection: 'recovery' }));

    renderSection();

    fireEvent.change(await screen.findByLabelText('Unlock with recovery code'), {
      target: { value: ` ${CODE} ` },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));

    await waitFor(() =>
      expect(screen.queryByLabelText('Unlock with recovery code')).not.toBeInTheDocument(),
    );
    expect(unlock).toHaveBeenCalledWith(CODE);
    expect(screen.getByText('Unlocked')).toBeInTheDocument();
  });

  it('shows a generic error for a wrong recovery code and stays locked', async () => {
    fetchStatus.mockResolvedValue(
      status({ state: 'locked', protection: 'recovery', reason: 'recovery_required' }),
    );
    unlock.mockRejectedValue(
      new SessionApiError('server detail', 400, {
        statusCode: 400,
        code: 'VALIDATION_ERROR',
        message: 'server detail',
        details: { code: 'VAULT_RECOVERY_CODE_INVALID' },
        timestamp: '',
        path: '/api/vault/unlock',
      }),
    );

    renderSection();

    fireEvent.change(await screen.findByLabelText('Unlock with recovery code'), {
      target: { value: 'wrong' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));

    expect(await screen.findByText('The recovery code is not correct.')).toBeInTheDocument();
    expect(screen.queryByText(/server detail/)).not.toBeInTheDocument();
    expect(screen.getByLabelText('Unlock with recovery code')).toBeInTheDocument();
  });

  it.each([
    [
      'file protection with disk runtime and linger hint',
      status({ protection: 'file', runtime: { protection: 'disk', lingerHint: true } }),
      ['Protection: file', 'Runtime files: disk'],
      true,
      true,
    ],
    [
      'keystore protection with memory runtime',
      status(),
      ['Protection: keystore', 'Runtime files: memory'],
      false,
      false,
    ],
  ])('shows protection badges for %s', async (_name, current, badges, fileWarning, linger) => {
    fetchStatus.mockResolvedValue(current);

    renderSection();

    for (const badge of badges) {
      expect(await screen.findByText(badge)).toBeInTheDocument();
    }
    expect(screen.queryByText(/a copy of ~\/\.devchain can decrypt/) !== null).toBe(fileWarning);
    expect(screen.queryByText(/loginctl enable-linger/) !== null).toBe(linger);
  });

  it.each([
    [{ cacheReady: true, cacheUnavailable: null }, /Home sent the values/],
    [{ cacheReady: false, cacheUnavailable: null }, /cannot start until home connects/],
    [
      { cacheReady: false, cacheUnavailable: 'runtime_directory_not_tmpfs' as const },
      /Run Update VM from home/,
    ],
  ])('tells a claimed VM whether its value cache is ready (%o)', async (vmCache, text) => {
    fetchStatus.mockResolvedValue(
      status({ state: 'not_set_up', protection: null, reason: 'claimed_host', vmCache }),
    );

    renderSection();

    expect(await screen.findByText(text)).toBeInTheDocument();
  });

  it('shows home ownership and no setup controls on a claimed VM', async () => {
    fetchStatus.mockResolvedValue(
      status({
        state: 'not_set_up',
        protection: null,
        reason: 'claimed_host',
        keystoreAvailable: false,
      }),
    );

    renderSection();

    expect(await screen.findByText('Vault managed by home')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });
});

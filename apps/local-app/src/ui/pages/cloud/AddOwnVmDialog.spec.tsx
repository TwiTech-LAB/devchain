// Layer: component. Request assertions prove both own-VM setup paths carry the key.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MIN_HOST_IMAGE_VERSION } from '@/modules/remotes/host-image';
import type { ProbeResultDto } from '@/modules/remotes/dtos/remote-probe.dto';
import type { RemoteListItemDto } from '@/modules/remotes/dtos/remote.dto';
import type { ProviderAuthEntryItem, RemoteOperationDto } from './lib/remote-vm-contracts';
import type { Project } from '@/ui/pages/projects/lib/project-contracts';
import { AddOwnVmDialog } from './AddOwnVmDialog';
import type { ProjectListRow } from './ProjectList';

type ProbeBody = { address: string; checkSsh: boolean };

let entries: ProviderAuthEntryItem[];
let identity: { user: string; homePath: string };
let sshKeys: Array<{ name: string; type: string | null; encrypted: boolean }> | 'fail';
let probe: jest.Mock<ProbeResultDto, [ProbeBody]>;
let fetchMock: jest.Mock;

function entry(
  partial: Partial<ProviderAuthEntryItem> & { id: string; provider: string },
): ProviderAuthEntryItem {
  return {
    kind: 'static',
    label: 'Entry',
    payloadKind: 'env',
    checkedOutRemoteId: null,
    createdAt: '2026-09-24T00:00:00.000Z',
    updatedAt: '2026-09-24T00:00:00.000Z',
    lastVerifiedAt: null,
    lastWritebackAt: null,
    ...partial,
  };
}

function projectRow(id: string, name: string): ProjectListRow {
  const project: Project = {
    id,
    workspaceId: 'w1',
    name,
    description: null,
    rootPath: `/work/${id}`,
    createdAt: '',
    updatedAt: '',
  };
  return {
    project,
    status: {
      state: 'local',
      label: 'This PC',
      note: null,
      tone: 'neutral',
      action: null,
      operation: null,
      remoteId: null,
    },
    onVm: false,
  };
}

const PROJECT_ROWS = [projectRow('p1', 'Project One'), projectRow('p2', 'Project Two')];

const LAB_VM = {
  id: 'r1',
  name: 'lab-vm',
  baseUrl: 'https://192.168.1.20:3000',
  kind: 'address',
} as RemoteListItemDto;

function operation(partial: Partial<RemoteOperationDto>): RemoteOperationDto {
  return {
    id: 'op-claim',
    kind: 'claim',
    remoteId: 'r1',
    projectId: null,
    state: 'running',
    details: {},
    steps: [],
    createdAt: '2026-09-26T00:00:00.000Z',
    updatedAt: '2026-09-26T00:00:00.000Z',
    ...partial,
  } as RemoteOperationDto;
}

function json(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

beforeEach(() => {
  entries = [];
  identity = { user: 'devchain', homePath: '/home/devchain' };
  sshKeys = [];
  probe = jest.fn();
  fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
    const path = String(url);
    if (path === '/api/remotes/probe') {
      return json(probe(JSON.parse(init?.body as string) as ProbeBody));
    }
    if (path === '/api/provider-auth') return json({ items: entries });
    if (path === '/api/runtime') return json({ version: '0.23.4' });
    if (path === '/api/remotes/host-install/identity') return json(identity);
    if (path === '/api/remotes/host-install/ssh-keys') {
      if (sshKeys === 'fail') throw new Error('offline');
      return json({ available: sshKeys.length > 0, keys: sshKeys });
    }
    if (path === '/api/remotes/host-install/estimate') {
      return json({
        projects: [
          { id: 'p1', bytes: 1024 ** 3, approximate: false },
          { id: 'p2', bytes: null, approximate: true },
        ],
        requiredDiskGib: 10,
      });
    }
    if (path.startsWith('/api/remotes/host-install/block?')) {
      return json({ block: 'devchain_host_install --check' });
    }
    return json({});
  });
  global.fetch = fetchMock as unknown as typeof fetch;
});

function renderDialog(props: Partial<Parameters<typeof AddOwnVmDialog>[0]> = {}) {
  const handlers = {
    onClose: jest.fn(),
    onAddVm: jest.fn(),
    onClaim: jest.fn(),
    onInstall: jest.fn(),
    onOpenActivity: jest.fn(),
    onViewVm: jest.fn(),
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <AddOwnVmDialog
        remotes={[]}
        operations={[]}
        projects={{
          rows: PROJECT_ROWS,
          workspaces: [],
          loading: false,
          error: null,
          truncated: false,
        }}
        pending={false}
        error={null}
        {...handlers}
        {...props}
      />
    </QueryClientProvider>,
  );
  return { ...handlers, unmount: view.unmount };
}

type User = ReturnType<typeof userEvent.setup>;

async function checkAddress(address: string, user: User = userEvent.setup()) {
  await user.type(screen.getByLabelText('VM address'), address);
  await user.click(screen.getByRole('button', { name: 'Check' }));
  return screen.findByRole('region', { name: 'Address check' });
}

async function chooseLogin(provider: string, option: string, user: User = userEvent.setup()) {
  await user.click(screen.getByRole('combobox', { name: `${provider} login choice` }));
  await user.click(await screen.findByRole('option', { name: option }));
}

const next = (user: User = userEvent.setup()) =>
  user.click(screen.getByRole('button', { name: 'Next' }));

const INSTALLER: ProbeResultDto = {
  kind: 'installer',
  bootstrapUrl: 'https://192.168.1.20:3000',
  state: 'unclaimed',
  imageVersion: '0.1.2',
  supported: true,
  remoteId: null,
};

const NOTHING: ProbeResultDto = {
  kind: 'nothing',
  tried: ['https://192.168.1.20:3000'],
  sshReachable: true,
};

/** As `openssl x509 -fingerprint -sha256` prints it, in lower case to prove normalisation. */
const PASTED_FINGERPRINT = `sha256 Fingerprint=${Array.from({ length: 32 }, (_, i) =>
  (i * 7 + 16).toString(16).padStart(2, '0'),
).join(':')}`;
const FINGERPRINT = Array.from({ length: 32 }, (_, i) => (i * 7 + 16).toString(16).padStart(2, '0'))
  .join('')
  .toUpperCase();

function pasteFingerprint(scope: HTMLElement = document.body, value = PASTED_FINGERPRINT) {
  fireEvent.change(within(scope).getByLabelText('Certificate fingerprint (SHA-256)'), {
    target: { value },
  });
}

/** Pastes the fingerprint on a waiting installer and goes on to the logins. */
async function continueWithFingerprint(result: HTMLElement, user: User = userEvent.setup()) {
  pasteFingerprint(result);
  await user.click(within(result).getByRole('button', { name: 'Continue' }));
}

const PUBLIC_KEY =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAiSBE1NBlKk4nbpiOPpInde42cTmc/k0AwWsBMKZVDr PC';

async function pastePublicKey() {
  await userEvent.click(screen.getByRole('combobox', { name: 'SSH key for devchain (optional)' }));
  await userEvent.click(screen.getByRole('option', { name: 'Paste a public key' }));
  fireEvent.change(screen.getByLabelText('SSH public key'), { target: { value: PUBLIC_KEY } });
}

describe('AddOwnVmDialog', () => {
  it('carries the pasted public key through an own-VM claim', async () => {
    probe.mockReturnValue(INSTALLER);
    const { onClaim } = renderDialog();
    const result = await checkAddress('192.168.1.20');
    await continueWithFingerprint(result);
    await pastePublicKey();
    await next();
    await userEvent.click(screen.getByRole('button', { name: 'Set up VM' }));
    expect(onClaim).toHaveBeenCalledWith(expect.objectContaining({ sshPublicKeys: [PUBLIC_KEY] }));
  });

  it('carries the public key through SSH installation and blocks invalid pasted keys', async () => {
    probe.mockReturnValue(NOTHING);
    const { onInstall } = renderDialog({
      projects: { rows: [], workspaces: [], loading: false, error: null, truncated: false },
    });
    const result = await checkAddress('192.168.1.20');
    await userEvent.click(within(result).getByRole('button', { name: 'Install over SSH' }));
    await userEvent.type(screen.getByLabelText('SSH user'), 'admin');
    await userEvent.type(screen.getByLabelText('SSH password'), 'secret');
    await next();
    await pastePublicKey();
    fireEvent.change(screen.getByLabelText('SSH public key'), { target: { value: 'invalid' } });
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('SSH public key'), { target: { value: PUBLIC_KEY } });
    await next();
    await userEvent.click(screen.getByRole('button', { name: 'Install and set up' }));
    expect(onInstall).toHaveBeenCalledWith(
      expect.objectContaining({ sshPublicKeys: [PUBLIC_KEY] }),
    );
  });

  describe('address check', () => {
    it('adds a DevChain that is not listed yet, named after its host', async () => {
      probe.mockReturnValue({
        kind: 'devchain',
        baseUrl: 'https://192.168.1.20:3000',
        version: '0.23.0',
        versionMatches: false,
        homePath: '/home/other',
        homePathMatches: false,
        remoteId: null,
      });
      const { onAddVm } = renderDialog();

      const result = await checkAddress('192.168.1.20');
      expect(probe).toHaveBeenCalledWith({ address: '192.168.1.20', checkSsh: true });
      expect(result).toHaveTextContent('DevChain 0.23.0 answers at 192.168.1.20:3000.');
      expect(result).toHaveTextContent("Its version differs from this PC's.");
      expect(result).toHaveTextContent("Its home folder (/home/other) differs from this PC's");
      expect(within(result).getByLabelText('Name')).toHaveValue('192.168.1.20');

      expect(within(result).getByRole('button', { name: 'Add VM' })).toBeDisabled();
      const key = `dck_${'a'.repeat(43)}`;
      expect(within(result).getByLabelText('API key')).toHaveAttribute('type', 'password');
      await userEvent.type(within(result).getByLabelText('API key'), key);
      // The key alone sends nothing: the fingerprint read on the VM comes first.
      expect(within(result).getByRole('button', { name: 'Add VM' })).toBeDisabled();
      pasteFingerprint(result);
      await userEvent.click(within(result).getByRole('button', { name: 'Add VM' }));
      expect(onAddVm).toHaveBeenCalledWith({
        name: '192.168.1.20',
        baseUrl: 'https://192.168.1.20:3000',
        apiKey: key,
        certificateFingerprint: FINGERPRINT,
      });
    });

    it('opens the details of a DevChain already in the list', async () => {
      probe.mockReturnValue({
        kind: 'devchain',
        baseUrl: 'https://192.168.1.20:3000',
        version: '0.23.4',
        versionMatches: true,
        homePath: '/home/devchain',
        homePathMatches: true,
        remoteId: 'r1',
      });
      const { onViewVm } = renderDialog({ remotes: [LAB_VM] });

      const result = await checkAddress('192.168.1.20');
      expect(result).toHaveTextContent('This VM is already in the list as lab-vm.');
      expect(within(result).queryByRole('button', { name: 'Add VM' })).not.toBeInTheDocument();
      await userEvent.click(within(result).getByRole('button', { name: 'Open details' }));
      expect(onViewVm).toHaveBeenCalledWith('r1');
    });

    it('sets up a waiting installer: logins, review, then Set up VM', async () => {
      probe.mockReturnValue(INSTALLER);
      const { onClaim } = renderDialog();
      const user = userEvent.setup();

      const result = await checkAddress('192.168.1.20', user);
      expect(result).toHaveTextContent('The installer is waiting at 192.168.1.20:3000.');
      expect(within(result).getByRole('button', { name: 'Continue' })).toBeDisabled();
      await continueWithFingerprint(result, user);

      expect(screen.getByText('Step 2 of 3: Logins')).toBeInTheDocument();
      await chooseLogin('codex', 'New login (sign in during setup)', user);
      await chooseLogin('agy', 'New login (sign in during setup)', user);
      await next(user);

      const how = screen.getByLabelText('How');
      expect(how).toHaveTextContent('Set up the installer at 192.168.1.20:3000');
      expect(screen.getByLabelText('Logins')).toHaveTextContent(
        'Codex: New login (sign in during setup)',
      );
      expect(screen.getByLabelText('Logins')).toHaveTextContent(
        'Antigravity: New login (sign in during setup)',
      );
      expect(screen.getByRole('switch', { name: 'Install Docker' })).toBeChecked();
      await user.click(screen.getByRole('button', { name: 'Set up VM' }));

      expect(onClaim).toHaveBeenCalledWith({
        baseUrl: 'https://192.168.1.20:3000',
        certificateFingerprint: FINGERPRINT,
        name: '192.168.1.20',
        providerAuth: { codex: 'generate', agy: 'generate' },
        installDocker: true,
      });
    });

    it('goes to setup for an installer whose VM is already registered', async () => {
      probe.mockReturnValue({ ...INSTALLER, remoteId: 'r1' });
      entries = [
        entry({
          id: 'mine',
          provider: 'codex',
          kind: 'family',
          label: 'Lab family',
          checkedOutRemoteId: 'r1',
        }),
        entry({
          id: 'theirs',
          provider: 'agy',
          kind: 'family',
          label: 'Agy family',
          checkedOutRemoteId: 'r2',
        }),
      ];
      const { onClaim } = renderDialog({
        remotes: [
          LAB_VM,
          { ...LAB_VM, id: 'r2', name: 'vm-two', baseUrl: 'https://10.0.0.2:3000' },
        ],
      });
      const user = userEvent.setup();

      const result = await checkAddress('192.168.1.20', user);
      await continueWithFingerprint(result, user);

      // The registered VM's own login stays usable; another VM's does not.
      await waitFor(() =>
        expect(screen.getByRole('combobox', { name: 'codex login choice' })).toHaveTextContent(
          'Lab family · Login',
        ),
      );
      await user.click(screen.getByRole('combobox', { name: 'agy login choice' }));
      expect(
        await screen.findByRole('option', { name: 'Agy family · Login · on vm-two' }),
      ).toHaveAttribute('aria-disabled', 'true');
      await user.keyboard('{Escape}');
      await next(user);
      await user.click(screen.getByRole('button', { name: 'Set up VM' }));

      // The claim by address reuses the registration.
      expect(onClaim).toHaveBeenCalledWith(
        expect.objectContaining({
          baseUrl: 'https://192.168.1.20:3000',
          providerAuth: { codex: 'reuse:mine' },
        }),
      );
      expect(onClaim.mock.calls[0][0]).not.toHaveProperty('remoteId');
    });

    it("says setup is running on a busy installer and opens this PC's Activity", async () => {
      probe.mockReturnValue({ ...INSTALLER, state: 'claiming', remoteId: 'r1' });
      const { onOpenActivity } = renderDialog({
        remotes: [LAB_VM],
        operations: [operation({ state: 'running' })],
      });

      const result = await checkAddress('192.168.1.20');
      expect(result).toHaveTextContent('Setup is already running on this VM.');
      expect(within(result).queryByRole('button', { name: 'Continue' })).not.toBeInTheDocument();
      await userEvent.click(within(result).getByRole('button', { name: 'Open Activity' }));
      expect(onOpenActivity).toHaveBeenCalledWith('op-claim');
    });

    it('offers no Activity for a setup that another PC runs', async () => {
      probe.mockReturnValue({ ...INSTALLER, state: 'handover' });
      renderDialog();

      const result = await checkAddress('192.168.1.20');
      expect(result).toHaveTextContent('Setup is already running on this VM.');
      expect(within(result).queryByRole('button')).not.toBeInTheDocument();
    });

    it("shows the server's message for an installer image that is too old", async () => {
      probe.mockReturnValue({ ...INSTALLER, imageVersion: '0.0.9', supported: false });
      renderDialog();

      const result = await checkAddress('192.168.1.20');
      expect(within(result).getByRole('alert')).toHaveTextContent(
        `Host image 0.0.9 is not supported; ${MIN_HOST_IMAGE_VERSION} or later is needed.`,
      );
      expect(within(result).queryByRole('button', { name: 'Continue' })).not.toBeInTheDocument();
    });

    it('names every place that did not answer when SSH does not answer either', async () => {
      probe.mockReturnValue({
        kind: 'nothing',
        tried: ['https://192.168.1.50:3000', 'https://192.168.1.50:4000'],
        sshReachable: false,
      });
      renderDialog();

      const result = await checkAddress('192.168.1.50');

      expect(within(result).getByRole('button', { name: 'Install over SSH' })).toBeEnabled();
      expect(
        within(result).getByRole('button', { name: 'Run the install block yourself' }),
      ).toBeEnabled();
    });

    it('switches between installation methods for an already registered address', async () => {
      probe.mockReturnValue(NOTHING);

      renderDialog({ remotes: [LAB_VM] });
      const user = userEvent.setup();

      const result = await checkAddress('192.168.1.20', user);
      await user.click(within(result).getByRole('button', { name: 'Install over SSH' }));
      expect(screen.getByText('Step 2 of 4: Install over SSH')).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Back' }));
      await user.click(
        within(await screen.findByRole('region', { name: 'Address check' })).getByRole('button', {
          name: 'Run the install block yourself',
        }),
      );
      expect(screen.getByText('Step 2 of 4: Install block')).toBeInTheDocument();
    });

    it('never starts a second setup next to a failed one', async () => {
      probe.mockReturnValue({ ...INSTALLER, remoteId: 'r1' });
      const { onOpenActivity, onClaim } = renderDialog({
        remotes: [LAB_VM],
        operations: [operation({ state: 'failed' })],
      });

      const result = await checkAddress('192.168.1.20');
      expect(within(result).getByRole('alert')).toHaveTextContent(
        'Setup of this VM stopped. Resolve it in Activity before you set it up again.',
      );
      expect(within(result).queryByRole('button', { name: 'Continue' })).not.toBeInTheDocument();
      await userEvent.click(within(result).getByRole('button', { name: 'Resolve' }));
      expect(onOpenActivity).toHaveBeenCalledWith('op-claim');
      expect(onClaim).not.toHaveBeenCalled();
    });

    it('offers no install next to a failed install of the same VM', async () => {
      probe.mockReturnValue(NOTHING);
      renderDialog({
        remotes: [LAB_VM],
        operations: [operation({ id: 'op-install', kind: 'install_host', state: 'failed' })],
      });

      const result = await checkAddress('192.168.1.20');
      expect(result).toHaveTextContent('Setup of this VM stopped.');
      expect(
        within(result).queryByRole('button', { name: 'Install over SSH' }),
      ).not.toBeInTheDocument();
    });

    it("checks a VM row's host as soon as it opens", async () => {
      probe.mockReturnValue(INSTALLER);
      renderDialog({ initialAddress: '10.0.0.5' });

      expect(await screen.findByRole('region', { name: 'Address check' })).toHaveTextContent(
        'The installer is waiting',
      );
      expect(screen.getByLabelText('VM address')).toHaveValue('10.0.0.5');
      expect(probe).toHaveBeenCalledWith({ address: '10.0.0.5', checkSsh: true });
    });

    it('refuses an address with a path without checking it', async () => {
      renderDialog();
      await userEvent.type(screen.getByLabelText('VM address'), '192.168.1.20/admin');
      await userEvent.click(screen.getByRole('button', { name: 'Check' }));

      expect(screen.getByRole('alert')).toHaveTextContent(
        'Enter a host, host:port or https://host:port.',
      );
      expect(probe).not.toHaveBeenCalled();
    });
  });

  describe('install block', () => {
    afterEach(() => {
      jest.useRealTimers();
    });

    it("checks the installer's port 5 s after each answer, from host:4000, and goes on when it answers", async () => {
      jest.useFakeTimers();
      const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
      probe
        .mockReturnValueOnce({
          kind: 'nothing',
          tried: ['https://192.168.1.50:4000'],
          sshReachable: true,
        })
        .mockReturnValueOnce({
          kind: 'nothing',
          tried: ['https://192.168.1.50:3000'],
          sshReachable: null,
        })
        .mockReturnValueOnce({ ...INSTALLER, bootstrapUrl: 'https://192.168.1.50:3000' });
      const { onClaim } = renderDialog();

      const result = await checkAddress('192.168.1.50:4000', user);
      await user.click(
        within(result).getByRole('button', { name: 'Run the install block yourself' }),
      );
      expect(await screen.findByLabelText('Install block')).toHaveValue(
        'devchain_host_install --check',
      );
      expect(
        screen.getByText('Waiting for the installer at 192.168.1.50:3000…'),
      ).toBeInTheDocument();
      await waitFor(() => expect(probe).toHaveBeenCalledTimes(2));
      expect(probe).toHaveBeenLastCalledWith({
        address: 'https://192.168.1.50:3000',
        checkSsh: false,
      });

      await act(async () => {
        jest.advanceTimersByTime(4_900);
      });
      expect(probe).toHaveBeenCalledTimes(2);
      await act(async () => {
        jest.advanceTimersByTime(100);
      });
      await waitFor(() => expect(probe).toHaveBeenCalledTimes(3));

      expect(
        await screen.findByText('The installer answers at 192.168.1.50:3000.'),
      ).toBeInTheDocument();
      // No way on without the fingerprint that the block printed.
      expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
      pasteFingerprint(document.body, 'not-a-fingerprint');
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Enter the SHA-256 fingerprint of the VM certificate',
      );
      expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
      pasteFingerprint();
      await user.click(screen.getByRole('button', { name: 'Continue' }));

      expect(await screen.findByText('Step 3 of 4: Logins')).toBeInTheDocument();
      await next(user);
      await user.click(screen.getByRole('button', { name: 'Set up VM' }));
      expect(onClaim).toHaveBeenCalledWith(
        expect.objectContaining({
          baseUrl: 'https://192.168.1.50:3000',
          certificateFingerprint: FINGERPRINT,
          name: '192.168.1.50',
        }),
      );
    });

    it('stops checking when the dialog closes', async () => {
      jest.useFakeTimers();
      const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
      probe.mockReturnValue(NOTHING);
      const { unmount } = renderDialog();

      const result = await checkAddress('192.168.1.20', user);
      await user.click(
        within(result).getByRole('button', { name: 'Run the install block yourself' }),
      );
      await waitFor(() => expect(probe).toHaveBeenCalledTimes(2));
      unmount();
      await act(async () => {
        jest.advanceTimersByTime(20_000);
      });
      expect(probe).toHaveBeenCalledTimes(2);
    });

    it('copies the install block', async () => {
      const clipboardWrite = jest.fn().mockResolvedValue(undefined);
      const user = userEvent.setup();
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: clipboardWrite },
      });
      probe.mockReturnValue(NOTHING);
      renderDialog();

      const result = await checkAddress('192.168.1.20', user);
      await user.click(
        within(result).getByRole('button', { name: 'Run the install block yourself' }),
      );
      await screen.findByLabelText('Install block');
      await user.click(screen.getByRole('button', { name: 'Copy install block' }));
      await waitFor(() =>
        expect(clipboardWrite).toHaveBeenCalledWith('devchain_host_install --check'),
      );
      expect(await screen.findByText('Install block copied.')).toBeInTheDocument();
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/remotes/host-install/block?minDiskGib=8',
        expect.anything(),
      );
    });
  });

  describe('install over SSH', () => {
    async function openSshStep(user: User, address = '192.168.1.20') {
      probe.mockReturnValue(NOTHING);
      const result = await checkAddress(address, user);
      await user.click(within(result).getByRole('button', { name: 'Install over SSH' }));
    }

    async function fillPassword(user: User, sshUser = 'ubuntu', password = 'secret-password') {
      await user.type(screen.getByLabelText('SSH user'), sshUser);
      await user.type(screen.getByLabelText('SSH password'), password);
    }

    async function toReviewAndStart(user: User) {
      await next(user);
      await next(user);
      await user.click(screen.getByRole('button', { name: 'Install and set up' }));
    }

    it('measures the selected projects, asks for their disk and sends the credentials once', async () => {
      const { onInstall } = renderDialog();
      const user = userEvent.setup();
      await openSshStep(user);

      expect(screen.getByRole('switch', { name: 'Install Docker' })).toBeChecked();
      await user.click(screen.getByRole('checkbox', { name: 'Include Project One' }));
      await user.click(screen.getByRole('checkbox', { name: 'Include Project Two' }));
      expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
      await user.click(screen.getByRole('button', { name: 'Measure' }));
      await waitFor(() => expect(screen.getByText('10 GiB')).toBeInTheDocument());
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/remotes/host-install/estimate',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ projectIds: ['p1', 'p2'] }),
        }),
      );
      expect(screen.getByText('1.0 GB')).toBeInTheDocument();
      expect(screen.getByText('unknown')).toBeInTheDocument();

      await fillPassword(user);
      await next(user);
      await next(user);
      expect(screen.getByLabelText('How')).toHaveTextContent(
        'Install over SSH as ubuntu, then set up',
      );
      expect(screen.getByLabelText('Free disk')).toHaveTextContent('10 GiB');
      await user.click(screen.getByRole('button', { name: 'Install and set up' }));

      expect(onInstall).toHaveBeenCalledWith({
        address: 'https://192.168.1.20',
        ssh: { user: 'ubuntu', password: 'secret-password' },
        name: '192.168.1.20',
        providerAuth: {},
        installDocker: true,
        minDiskGib: 10,
      });
      // The password is gone; another attempt asks for it again.
      expect(screen.getByText('Go back and enter the SSH credentials again.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Install and set up' })).toBeDisabled();
    });

    it('sends no Docker install when its switch is off', async () => {
      const { onInstall } = renderDialog({
        projects: { rows: [], workspaces: [], loading: false, error: null, truncated: false },
      });
      const user = userEvent.setup();
      await openSshStep(user);

      await user.click(screen.getByRole('switch', { name: 'Install Docker' }));
      await fillPassword(user);
      await toReviewAndStart(user);
      expect(onInstall.mock.calls[0][0]).not.toHaveProperty('installDocker');
    });

    it("lists this PC's keys and sends only the chosen key's name", async () => {
      sshKeys = [
        { name: 'id_rsa', type: 'ssh-rsa', encrypted: false },
        { name: 'id_ed25519', type: 'ssh-ed25519', encrypted: true },
      ];
      const { onInstall } = renderDialog({
        projects: { rows: [], workspaces: [], loading: false, error: null, truncated: false },
      });
      const user = userEvent.setup();
      await openSshStep(user);

      await user.type(screen.getByLabelText('SSH user'), 'ubuntu');
      await user.click(screen.getByLabelText('Sign in with'));
      await user.click(await screen.findByRole('option', { name: 'A key from this PC' }));
      const key = screen.getByLabelText("Key (the DevChain user's ~/.ssh)");
      expect(key).toHaveTextContent('id_rsa · ssh-rsa');
      expect(screen.queryByLabelText('Private key')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Key passphrase (optional)')).not.toBeInTheDocument();

      await user.click(key);
      await user.click(
        await screen.findByRole('option', { name: 'id_ed25519 · ssh-ed25519 · passphrase' }),
      );
      await user.type(screen.getByLabelText('Key passphrase (optional)'), 'key-secret');
      await toReviewAndStart(user);

      expect(onInstall).toHaveBeenCalledWith(
        expect.objectContaining({
          ssh: { user: 'ubuntu', keyName: 'id_ed25519', passphrase: 'key-secret' },
        }),
      );
    });

    it('offers only a password or a pasted key when this PC lists no keys', async () => {
      sshKeys = 'fail';
      renderDialog();
      const user = userEvent.setup();
      await openSshStep(user);

      await user.click(screen.getByLabelText('Sign in with'));
      const options = await screen.findAllByRole('option');
      expect(options.map((option) => option.textContent)).toEqual(['Password', 'A pasted key']);
      await user.click(screen.getByRole('option', { name: 'A pasted key' }));
      expect(screen.getByLabelText('Private key')).toBeInTheDocument();
    });

    it('selects no project by default and installs with the 8 GiB base, without measuring', async () => {
      const { onInstall } = renderDialog();
      const user = userEvent.setup();
      await openSshStep(user);

      expect(screen.getByRole('checkbox', { name: 'Include Project One' })).not.toBeChecked();
      expect(screen.getByRole('checkbox', { name: 'Include Project Two' })).not.toBeChecked();
      expect(screen.getByRole('button', { name: 'Measure' })).toBeDisabled();
      expect(
        screen.getByText('8 GiB (base requirement; no projects selected)'),
      ).toBeInTheDocument();
      await fillPassword(user);
      await toReviewAndStart(user);

      expect(onInstall).toHaveBeenCalledWith(expect.objectContaining({ minDiskGib: 8 }));
      expect(fetchMock).not.toHaveBeenCalledWith(
        '/api/remotes/host-install/estimate',
        expect.anything(),
      );
    });

    it("refuses to start while this PC's user name fails the setup rule", async () => {
      identity = { user: 'first.last', homePath: '/home/first.last' };
      const { onInstall } = renderDialog({
        projects: { rows: [], workspaces: [], loading: false, error: null, truncated: false },
      });
      const user = userEvent.setup();
      await openSshStep(user);
      await fillPassword(user);
      await next(user);
      await next(user);

      expect(
        await screen.findByText(/This PC's user name "first\.last" cannot claim a VM/),
      ).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Install and set up' })).toBeDisabled();
      expect(onInstall).not.toHaveBeenCalled();
    });
  });

  describe('logins and review', () => {
    async function toLogins(user: User) {
      probe.mockReturnValue(INSTALLER);
      const result = await checkAddress('192.168.1.20', user);
      await continueWithFingerprint(result, user);
    }

    it('preselects the only Claude token and sends it as reuse', async () => {
      entries = [entry({ id: 'e1', provider: 'claude', label: 'Main token' })];
      const { onClaim } = renderDialog();
      const user = userEvent.setup();
      await toLogins(user);

      await waitFor(() =>
        expect(screen.getByRole('combobox', { name: 'claude login choice' })).toHaveTextContent(
          'Main token · Token',
        ),
      );
      await next(user);
      await user.click(screen.getByRole('button', { name: 'Set up VM' }));

      expect(onClaim).toHaveBeenCalledWith(
        expect.objectContaining({ providerAuth: { claude: 'reuse:e1' } }),
      );
      // The VM always gets this PC's identity; the request carries no user or home.
      expect(onClaim.mock.calls[0][0]).not.toHaveProperty('userName');
      expect(onClaim.mock.calls[0][0]).not.toHaveProperty('homePath');
    });

    it('sends new logins and leaves out None', async () => {
      entries = [entry({ id: 'e1', provider: 'claude', label: 'Main token' })];
      const { onClaim } = renderDialog();
      const user = userEvent.setup();
      await toLogins(user);

      await chooseLogin('codex', 'New login (sign in during setup)', user);
      await waitFor(() =>
        expect(screen.getByRole('combobox', { name: 'claude login choice' })).toHaveTextContent(
          'Main token · Token',
        ),
      );
      await chooseLogin('claude', 'None', user);
      await next(user);
      await user.click(screen.getByRole('button', { name: 'Set up VM' }));

      expect(onClaim.mock.calls[0][0].providerAuth).toEqual({ codex: 'generate' });
    });

    it('sends no Docker install when the review switch is off', async () => {
      const { onClaim } = renderDialog();
      const user = userEvent.setup();
      await toLogins(user);
      await next(user);

      await user.click(screen.getByRole('switch', { name: 'Install Docker' }));
      await user.click(screen.getByRole('button', { name: 'Set up VM' }));
      expect(onClaim.mock.calls[0][0]).not.toHaveProperty('installDocker');
    });

    it("shows this PC's identity read-only and uses the edited name", async () => {
      const { onClaim } = renderDialog();
      const user = userEvent.setup();
      await toLogins(user);
      await next(user);

      await waitFor(() =>
        expect(screen.getByLabelText('Linux user')).toHaveTextContent('devchain'),
      );

      await user.clear(screen.getByLabelText('Name'));
      await user.type(screen.getByLabelText('Name'), 'workstation');
      await user.click(screen.getByRole('button', { name: 'Set up VM' }));
      expect(onClaim).toHaveBeenCalledWith(expect.objectContaining({ name: 'workstation' }));
    });
  });
});

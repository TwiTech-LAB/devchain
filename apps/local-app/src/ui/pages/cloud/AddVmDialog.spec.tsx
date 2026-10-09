// Layer: component. The dialog owns key selection, paste validation and the create request.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ProviderAuthEntryItem } from './lib/remote-vm-contracts';
import type { AvailableSshPublicKey } from '@/modules/remotes/host-install/ssh-key.service';
import { AddVmDialog, type CreateVmRequest } from './AddVmDialog';

let identity: { user: string; homePath: string };
let entries: ProviderAuthEntryItem[];
const PUBLIC_KEY =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAiSBE1NBlKk4nbpiOPpInde42cTmc/k0AwWsBMKZVDr PC';
let publicKeys: AvailableSshPublicKey[];

beforeEach(() => {
  identity = { user: 'devchain', homePath: '/home/devchain' };
  entries = [];
  publicKeys = [];
  global.fetch = jest.fn(async (url: string | undefined) => {
    const target = String(url);
    if (target === '/api/remotes/host-install/ssh-public-keys')
      return { ok: true, json: async () => ({ available: true, keys: publicKeys }) } as Response;
    if (target === '/api/remotes/host-install/identity') {
      return { ok: true, json: async () => identity } as Response;
    }
    if (target === '/api/provider-auth') {
      return { ok: true, json: async () => ({ items: entries }) } as Response;
    }
    if (target === '/api/runtime') {
      return { ok: true, json: async () => ({ version: '0.23.4' }) } as Response;
    }
    return { ok: true, json: async () => ({}) } as Response;
  }) as unknown as typeof fetch;
});

function renderDialog() {
  const onCreate = jest.fn<void, [CreateVmRequest]>();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <AddVmDialog
        connectionName="Lab"
        namePrefix="dc-"
        remoteNames={new Map([['r-lab', 'vm-lab']])}
        pending={false}
        onClose={jest.fn()}
        onCreate={onCreate}
      />
    </QueryClientProvider>,
  );
  return onCreate;
}

const next = () => userEvent.click(screen.getByRole('button', { name: 'Next' }));

/** Details with a name, then Logins, then Review. */
async function toReview(name = 'workstation') {
  await userEvent.type(screen.getByLabelText('Name'), name);
  await next();
  await next();
}

const create = () => userEvent.click(screen.getByTestId('add-vm-submit'));

describe('AddVmDialog', () => {
  it('sends the selected public key from this PC', async () => {
    publicKeys = [
      {
        name: 'id_ed25519.pub',
        type: 'ssh-ed25519',
        fingerprint: 'SHA256:fixture',
        comment: 'PC',
        content: PUBLIC_KEY,
      },
    ];
    const onCreate = renderDialog();
    await userEvent.type(screen.getByLabelText('Name'), 'ssh-vm');
    await next();
    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/remotes/host-install/ssh-public-keys',
        expect.anything(),
      ),
    );
    await userEvent.click(
      screen.getByRole('combobox', { name: 'SSH key for devchain (optional)' }),
    );
    await userEvent.click(
      await screen.findByRole('option', { name: 'id_ed25519.pub · ssh-ed25519' }),
    );
    expect(screen.getByText('SHA256:fixture · PC')).toBeInTheDocument();
    await next();
    await create();
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ sshPublicKeys: [PUBLIC_KEY] }));
  });

  it('rejects an invalid paste and sends a valid public key', async () => {
    const onCreate = renderDialog();
    await userEvent.type(screen.getByLabelText('Name'), 'ssh-vm');
    await next();
    await userEvent.click(
      screen.getByRole('combobox', { name: 'SSH key for devchain (optional)' }),
    );
    await userEvent.click(screen.getByRole('option', { name: 'Paste a public key' }));
    fireEvent.change(screen.getByLabelText('SSH public key'), {
      target: { value: '-----BEGIN OPENSSH PRIVATE KEY-----' },
    });
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a single OpenSSH public key');
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('SSH public key'), {
      target: { value: `${PUBLIC_KEY}\n` },
    });
    await next();
    await create();
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ sshPublicKeys: [PUBLIC_KEY] }));
  });

  describe('details', () => {
    it("previews the Proxmox name and applies Proxmox's DNS-name rules", async () => {
      renderDialog();
      const nameInput = screen.getByLabelText('Name');
      const validation =
        /Use up to 100 letters, digits, dots or hyphens\. Each dot-separated part must start and end with a letter or digit\./;

      for (const name of ['dev_box', 'box-', 'box.']) {
        await userEvent.clear(nameInput);
        await userEvent.type(nameInput, name);
        expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
        expect(screen.getByText(validation)).toBeInTheDocument();
      }
      await userEvent.clear(nameInput);
      await userEvent.type(nameInput, 'dev-box');
      expect(screen.getByText('Proxmox name: dc-dev-box')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();
      expect(screen.queryByText(validation)).not.toBeInTheDocument();
    });

    it.each([
      ['Medium', { cores: 4, memory: 8192, disk: 60 }],
      ['Large', { cores: 8, memory: 16384, disk: 120 }],
    ])('sends the %s preset', async (preset, size) => {
      const onCreate = renderDialog();
      const sizes = screen.getByRole('group', { name: 'Size' });
      expect(within(sizes).getByRole('button', { name: /^Small/ })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      await userEvent.click(within(sizes).getByRole('button', { name: new RegExp(`^${preset}`) }));
      await toReview();
      await create();

      expect(onCreate).toHaveBeenCalledWith(expect.objectContaining(size));
    });

    it("sends today's defaults with the Small preset", async () => {
      const onCreate = renderDialog();
      await toReview('worker');
      expect(screen.getByRole('region', { name: 'What DevChain will do' })).toHaveTextContent(
        'Create dc-worker on Lab: 2 vCPU · 4 GiB memory · 30 GiB disk.',
      );
      await create();

      expect(onCreate).toHaveBeenCalledWith({
        name: 'worker',
        cores: 2,
        memory: 4096,
        disk: 30,
        providerAuth: {},
        installDocker: true,
      });
    });

    it('keeps the minimums for a custom size', async () => {
      const onCreate = renderDialog();
      await userEvent.type(screen.getByLabelText('Name'), 'custom');
      await userEvent.click(screen.getByRole('button', { name: /^Custom/ }));
      const memory = screen.getByLabelText('Memory (MiB)');
      await userEvent.clear(memory);
      await userEvent.type(memory, '2048');
      expect(screen.getByText('Memory must be at least 4096 MiB.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();

      await userEvent.clear(memory);
      await userEvent.type(memory, '6144');
      const cores = screen.getByLabelText('Cores');
      await userEvent.clear(cores);
      await userEvent.type(cores, '3');
      await next();
      await next();
      await create();

      expect(onCreate).toHaveBeenCalledWith(
        expect.objectContaining({ cores: 3, memory: 6144, disk: 30 }),
      );
    });

    it('sends no Docker install when the switch is off', async () => {
      const onCreate = renderDialog();
      await userEvent.click(screen.getByRole('switch', { name: 'Install Docker' }));
      await toReview('plain-vm');
      expect(screen.getByRole('region', { name: 'What DevChain will do' })).toHaveTextContent(
        'Leave Docker out.',
      );
      await create();
      expect(onCreate.mock.calls[0][0]).not.toHaveProperty('installDocker');
    });
  });

  describe('logins', () => {
    it('never offers or preselects a login another VM holds', async () => {
      entries = [
        {
          id: 'f1',
          provider: 'codex',
          kind: 'family',
          label: 'Codex family',
          payloadKind: 'files',
          checkedOutRemoteId: 'r-lab',
          createdAt: '',
          updatedAt: '',
          lastVerifiedAt: null,
          lastWritebackAt: null,
        },
      ];
      const onCreate = renderDialog();
      await userEvent.type(screen.getByLabelText('Name'), 'worker');
      await next();

      await userEvent.click(screen.getByRole('combobox', { name: 'codex login choice' }));
      expect(
        await screen.findByRole('option', { name: 'Codex family · Login · on vm-lab' }),
      ).toHaveAttribute('aria-disabled', 'true');
      await userEvent.keyboard('{Escape}');
      expect(screen.getByRole('combobox', { name: 'codex login choice' })).toHaveTextContent(
        'None',
      );
      expect(screen.getByRole('button', { name: 'Add a token' })).toBeInTheDocument();
      await next();
      await create();
      expect(onCreate.mock.calls[0][0].providerAuth).toEqual({});
    });

    it('lists the chosen logins on Review', async () => {
      const onCreate = renderDialog();
      await userEvent.type(screen.getByLabelText('Name'), 'worker');
      await next();
      await userEvent.click(screen.getByRole('combobox', { name: 'codex login choice' }));
      await userEvent.click(
        await screen.findByRole('option', { name: 'New login (sign in during setup)' }),
      );
      await next();

      expect(screen.getByRole('region', { name: 'What DevChain will do' })).toHaveTextContent(
        'Place these logins: Codex: New login (sign in during setup).',
      );
      await create();
      expect(onCreate.mock.calls[0][0].providerAuth).toEqual({ codex: 'generate' });
    });
  });

  describe('review', () => {
    it("shows this PC's identity read-only and sends no user or home", async () => {
      const onCreate = renderDialog();
      await toReview();

      await waitFor(() =>
        expect(screen.getByLabelText('Linux user')).toHaveTextContent('devchain'),
      );

      await create();

      const body = onCreate.mock.calls[0][0] as CreateVmRequest & {
        userName?: string;
        homePath?: string;
      };
      expect(body.userName).toBeUndefined();
      expect(body.homePath).toBeUndefined();
    });

    it("refuses to create while this PC's user name fails the setup rule", async () => {
      identity = { user: 'first.last', homePath: '/home/first.last' };
      renderDialog();
      await toReview();

      await waitFor(() =>
        expect(screen.getByRole('alert')).toHaveTextContent(
          'This PC\'s user name "first.last" cannot claim a VM',
        ),
      );
      expect(screen.getByTestId('add-vm-submit')).toBeDisabled();
    });
  });
});

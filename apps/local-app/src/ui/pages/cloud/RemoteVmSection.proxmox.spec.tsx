import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  PROXMOX_CONNECTION,
  REMOTE,
  fx,
  pickAddVmMenu,
  renderSection,
  resetRemoteVmFixture,
} from './testing/remote-vm-section.fixture';

const mockUseAllProjects = jest.fn();
const mockUseWorkspaces = jest.fn();
jest.mock('@/ui/hooks/useAllProjects', () => ({
  useAllProjects: () => mockUseAllProjects(),
  useWorkspaces: () => mockUseWorkspaces(),
}));

const mockUseSelectedProject = jest.fn();
jest.mock('@/ui/hooks/useProjectSelection', () => ({
  useSelectedProject: () => mockUseSelectedProject(),
}));

jest.mock('@/ui/hooks/useHomeSocket', () => ({ useHomeSocket: jest.fn() }));

const toastSpy = jest.fn();
jest.mock('@/ui/hooks/use-toast', () => ({ useToast: () => ({ toast: toastSpy }) }));

beforeEach(() =>
  resetRemoteVmFixture({
    useSelectedProject: mockUseSelectedProject,
    useAllProjects: mockUseAllProjects,
    useWorkspaces: mockUseWorkspaces,
    toast: toastSpy,
  }),
);

const MANAGED = {
  ...REMOTE,
  id: 'r-managed',
  name: 'worker',
  kind: 'proxmox' as const,
  online: true,
  version: '0.23.4',
  versionMatches: true,
  vmProviderConnectionId: 'pc1',
  vmIdentity: '12345678-1234-1234-1234-123456789abc',
};

function rightsChecks(): number {
  return fx.calls.checkVmProviderRights.filter(([id]) => id === 'pc1').length;
}

const serverBox = () => screen.findByRole('region', { name: 'Proxmox lab' });

// UI integration: the boxes join the connections, the rights check and the VM count.
describe('RemoteVmSection Proxmox tab', () => {
  it("shows each server's facts and rights, checked once per page session; its VM count opens the VMs tab", async () => {
    fx.providerConnectionsData = [PROXMOX_CONNECTION];
    fx.remotesData = [{ ...REMOTE }, MANAGED];
    renderSection('/?tab=proxmox');

    const box = await serverBox();
    expect(box).toHaveTextContent('https://pve.test:8006');
    for (const fact of ['pve1', 'devchain', 'local-lvm', 'local', 'vmbr0']) {
      expect(box).toHaveTextContent(fact);
    }
    // Servers only: no per-server VM list or Add VM, just the count.
    expect(
      within(box).queryByRole('region', { name: 'VMs on Proxmox lab' }),
    ).not.toBeInTheDocument();
    expect(within(box).queryByRole('button', { name: 'Add VM' })).not.toBeInTheDocument();
    expect(within(box).getByRole('button', { name: '1 VM' })).toBeInTheDocument();
    expect(
      await within(box).findByText('All required Proxmox rights are present.'),
    ).toBeInTheDocument();
    expect(within(box).getByText(/^Checked /)).toBeInTheDocument();
    expect(rightsChecks()).toBe(1);

    await userEvent.click(within(box).getByRole('button', { name: '1 VM' }));
    expect(fx.search).toContain('tab=vms');

    await userEvent.click(screen.getByRole('tab', { name: /^Proxmox/ }));
    await serverBox();
    expect(rightsChecks()).toBe(1);

    fx.permissionMissing = ['VM.Allocate on /pool/devchain'];
    await userEvent.click(within(await serverBox()).getByRole('button', { name: 'Check again' }));
    const missing = await within(await serverBox()).findByRole('list', {
      name: 'Missing Proxmox rights',
    });
    expect(missing).toHaveTextContent('VM.Allocate on /pool/devchain');
    expect(rightsChecks()).toBe(2);
  });

  it('keeps Remove disabled with its reason while a VM uses the server', async () => {
    fx.providerConnectionsData = [PROXMOX_CONNECTION];
    fx.remotesData = [MANAGED];
    renderSection('/?tab=proxmox');

    const box = await serverBox();
    expect(within(box).getByRole('button', { name: 'Remove' })).toBeDisabled();
    expect(within(box).getByLabelText('Remove: worker uses this server')).toBeInTheDocument();
  });

  it('removes an unused server after confirmation', async () => {
    fx.providerConnectionsData = [PROXMOX_CONNECTION];
    renderSection('/?tab=proxmox');

    await userEvent.click(within(await serverBox()).getByRole('button', { name: 'Remove' }));
    const confirm = await screen.findByRole('dialog', { name: 'Remove Proxmox lab?' });
    expect(confirm).toHaveTextContent('Remove Proxmox lab?');
    await userEvent.click(within(confirm).getByRole('button', { name: 'Remove' }));

    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Proxmox lab' })).not.toBeInTheDocument(),
    );
    expect(fx.calls.deleteVmProvider).toContainEqual(['pc1']);
    expect(await screen.findByText('Create VMs on your Proxmox server')).toBeInTheDocument();
  });

  it('explains the three steps when no server is connected', async () => {
    renderSection('/?tab=proxmox');

    expect(await screen.findByText('Create VMs on your Proxmox server')).toBeInTheDocument();
    expect(screen.getByText('Paste the connection string it prints.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Connect a server' }));
    expect(screen.getByRole('dialog', { name: 'Connect a server' })).toHaveTextContent(
      'Step 1 of 3: Run the setup block',
    );
  });

  it('opens Create VM for a server from the VMs tab Add VM menu', async () => {
    fx.providerConnectionsData = [PROXMOX_CONNECTION];
    renderSection('/?tab=vms');

    await pickAddVmMenu('Create on Proxmox lab');
    const dialog = screen.getByRole('dialog', { name: 'Add a VM on Proxmox lab' });
    await userEvent.type(within(dialog).getByLabelText('Name'), 'box');
  });
});

describe('Proxmox connection setup', () => {
  it('copies the setup block, confirms the fingerprint and lists missing Proxmox rights', async () => {
    fx.permissionMissing = ['Sys.AccessNetwork on /nodes/pve1'];
    const clipboardWrite = jest.fn().mockResolvedValue(undefined);
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: clipboardWrite },
    });

    try {
      renderSection('/?tab=proxmox');
      await userEvent.click(await screen.findByRole('button', { name: 'Connect a server' }));
      const dialog = screen.getByRole('dialog');
      await userEvent.click(within(dialog).getByRole('button', { name: 'Advanced (optional)' }));
      await userEvent.type(within(dialog).getByLabelText('Node'), 'pve1');
      await userEvent.type(within(dialog).getByLabelText('Proxmox address'), '192.168.1.128');
      expect(
        within(dialog).getByText('Use the address you open the Proxmox web UI with.'),
      ).toBeInTheDocument();
      await userEvent.click(within(dialog).getByRole('button', { name: 'Generate setup block' }));
      expect(fx.calls.readProxmoxSetupBlock).toContainEqual([
        expect.objectContaining({ node: 'pve1', address: '192.168.1.128' }),
      ]);
      expect(await within(dialog).findByLabelText('Generated setup block')).toHaveValue(
        'pveum pool add devchain',
      );
      await userEvent.click(within(dialog).getByRole('button', { name: 'Copy setup block' }));
      expect(clipboardWrite).toHaveBeenCalledWith('pveum pool add devchain');

      await userEvent.click(within(dialog).getByRole('button', { name: 'Next' }));
      const connectionString =
        'devchain-proxmox://pve.test:8006/pve1?pool=devchain&storage=local-lvm&imageStorage=local&bridge=vmbr0&fp=AA&token=devchain%40pve!agent:secret';
      await userEvent.type(within(dialog).getByLabelText('Connection string'), connectionString);
      await userEvent.click(within(dialog).getByRole('button', { name: 'Review fingerprint' }));
      expect(await within(dialog).findByTestId('proxmox-fingerprint')).toHaveTextContent(
        PROXMOX_CONNECTION.sslFingerprint,
      );
      const placement = within(dialog).getByTestId('proxmox-placement');
      expect(placement).toHaveTextContent('pve1');
      expect(placement).toHaveTextContent('local-lvm');
      expect(placement).toHaveTextContent('local');
      expect(placement).toHaveTextContent('vmbr0');
      expect(placement).toHaveTextContent('devchain');
      expect(placement).toHaveTextContent('https://pve.test:8006');
      const confirmButton = within(dialog).getByRole('button', { name: 'Connect' });
      expect(confirmButton).toBeDisabled();
      await userEvent.click(
        within(dialog).getByRole('checkbox', { name: 'Confirm Proxmox fingerprint' }),
      );
      await userEvent.click(confirmButton);

      expect(await within(dialog).findByText('Missing Proxmox rights:')).toBeInTheDocument();
      expect(
        within(dialog).getByRole('list', { name: 'Missing Proxmox rights' }),
      ).toHaveTextContent('Sys.AccessNetwork on /nodes/pve1');
      expect(within(dialog).getByText(/re-run the setup block/i)).toBeInTheDocument();
      expect(fx.calls.connectProxmox).toContainEqual([connectionString]);
      await userEvent.click(within(dialog).getByRole('button', { name: 'Add VM' }));
      // The connect dialog's Add VM lands on the VMs tab, where Create VM lives now.
      expect(fx.search).toContain('tab=vms');
      expect(
        await screen.findByRole('dialog', { name: 'Add a VM on Proxmox lab' }),
      ).toBeInTheDocument();
    } finally {
      if (clipboardDescriptor) {
        Object.defineProperty(navigator, 'clipboard', clipboardDescriptor);
      } else {
        Reflect.deleteProperty(navigator, 'clipboard');
      }
    }
  });
  it('generates a discovering setup block with empty inputs and collapses the advanced fields by default', async () => {
    renderSection('/?tab=proxmox');
    await userEvent.click(await screen.findByRole('button', { name: 'Connect a server' }));
    const dialog = screen.getByRole('dialog');

    await userEvent.click(within(dialog).getByRole('button', { name: 'Generate setup block' }));
    expect(fx.calls.readProxmoxSetupBlock).toContainEqual([
      { node: '', address: '', pool: 'devchain', storage: '', imageStorage: '', bridge: '' },
    ]);
    expect(await within(dialog).findByLabelText('Generated setup block')).toHaveValue(
      'pveum pool add devchain',
    );
  });
  it('leaves an empty pool out of the setup block query', async () => {
    renderSection('/?tab=proxmox');
    await userEvent.click(await screen.findByRole('button', { name: 'Connect a server' }));
    const dialog = screen.getByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Advanced (optional)' }));
    await userEvent.clear(within(dialog).getByRole('textbox', { name: 'Pool' }));

    await userEvent.click(within(dialog).getByRole('button', { name: 'Generate setup block' }));
    expect(fx.calls.readProxmoxSetupBlock).toContainEqual([
      { node: '', address: '', pool: '', storage: '', imageStorage: '', bridge: '' },
    ]);
  });
});

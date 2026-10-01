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

const mockUseSelectedProject = jest.fn();
jest.mock('@/ui/hooks/useProjectSelection', () => ({
  useSelectedProject: () => mockUseSelectedProject(),
}));

jest.mock('@/ui/hooks/useHomeSocket', () => ({ useHomeSocket: jest.fn() }));

const toastSpy = jest.fn();
jest.mock('@/ui/hooks/use-toast', () => ({ useToast: () => ({ toast: toastSpy }) }));

beforeEach(() =>
  resetRemoteVmFixture({ useSelectedProject: mockUseSelectedProject, toast: toastSpy }),
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
  return fx.mockFetch.mock.calls.filter(([url]) => String(url) === '/api/vm-providers/pc1/check')
    .length;
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
    expect(fx.mockFetch).toHaveBeenCalledWith(
      '/api/vm-providers/pc1',
      expect.objectContaining({ method: 'DELETE' }),
    );
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
    expect(within(dialog).getByText('Proxmox name: devchain-box')).toBeInTheDocument();
  });
});

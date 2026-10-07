// Component layer: a plan response controls both the mismatch note and the emitted selection.
import { render, screen, waitFor } from '@testing-library/react';
import type { DockerPlan } from '@/modules/remotes/docker/docker-plan.dto';
import { apiFetch } from '@/ui/lib/api-transport';
import { ConnectDockerSection, NO_DOCKER_STATE } from './ConnectDockerSection';

jest.mock('@/ui/lib/api-transport', () => ({ HOME_BACKEND: 'home', apiFetch: jest.fn() }));

it.each([
  { holder: 'ubuntu', managedVm: false },
  { holder: null, managedVm: false },
  { holder: 'ubuntu', managedVm: true },
])(
  'explains the unavailable automatic move with holder $holder, managed VM $managedVm',
  async ({ holder, managedVm }) => {
    const plan: DockerPlan = {
      projectId: 'p1',
      remoteId: 'r1',
      scannedAt: '',
      availability: {
        available: false,
        side: 'remote',
        reason: { code: 'vm-user-mismatch', message: 'The user ids differ.' },
        userMismatch: {
          homeUid: 1000,
          homeGid: 1000,
          vmUid: 1001,
          vmGid: 1000,
          uidConflict: { requestedUid: 1000, holder },
        },
      },
      apiVersion: null,
      items: [],
      filesystems: [],
      copySize: { bytes: 0, unknown: false },
      fit: 'unknown',
      canConnect: false,
      warnings: [],
      managedExclusions: [],
      codePaths: [],
      reconnect: null,
      estimate: null,
    };
    jest.mocked(apiFetch).mockResolvedValue({ ok: true, json: async () => plan } as Response);
    const onStateChange = jest.fn();
    render(
      <ConnectDockerSection
        projectId="p1"
        presence="present"
        remoteId="r1"
        disabled={false}
        initialIncludeDocker
        managedVm={managedVm}
        onStateChange={onStateChange}
      />,
    );

    const note = await screen.findByRole('note', { name: 'Docker availability' });
    expect(note).toHaveTextContent('Automatic Docker move is off for this VM.');
    expect(note).toHaveTextContent(
      'Connect, file sync and agents work as usual. Only the automatic move of containers and their data needs the same user ids on this PC and the VM: here 1000:1000 and 1001:1000.',
    );
    expect(note).toHaveTextContent(
      'You can still move what you need yourself, for example with docker save and docker load for images, and a volume export and import for data.',
    );
    if (holder) expect(note).toHaveTextContent('(uid 1000 belongs to ubuntu on the VM)');
    else expect(note).not.toHaveTextContent('belongs to');
    if (holder && !managedVm)
      expect(note).toHaveTextContent(
        'To turn it on, set up the VM from another account and remove ubuntu, or use a VM where uid 1000 is free.',
      );
    else expect(note).not.toHaveTextContent('To turn it on');
    await waitFor(() =>
      expect(onStateChange).toHaveBeenLastCalledWith(
        expect.objectContaining({
          items: [],
          ready: false,
          pending: false,
        }),
      ),
    );
  },
);

it.each([
  { presence: 'absent', initialIncludeDocker: false, visible: false, pending: false },
  { presence: 'absent', initialIncludeDocker: true, visible: false, pending: false },
  { presence: 'loading', initialIncludeDocker: false, visible: false, pending: false },
  { presence: 'loading', initialIncludeDocker: true, visible: false, pending: true },
  { presence: 'present', initialIncludeDocker: false, visible: true, pending: false },
  { presence: 'unknown', initialIncludeDocker: false, visible: true, pending: false },
] as const)(
  'presence $presence with saved Docker $initialIncludeDocker controls the box and gate',
  ({ presence, initialIncludeDocker, visible, pending }) => {
    jest.mocked(apiFetch).mockReset();
    const onStateChange = jest.fn();
    render(
      <ConnectDockerSection
        projectId="p1"
        remoteId="r1"
        presence={presence}
        disabled={false}
        initialIncludeDocker={initialIncludeDocker}
        onStateChange={onStateChange}
      />,
    );
    const checkbox = screen.queryByRole('checkbox', { name: 'Include Docker containers' });
    if (visible) expect(checkbox).toBeInTheDocument();
    else expect(checkbox).not.toBeInTheDocument();
    expect(apiFetch).not.toHaveBeenCalled();
    expect(onStateChange).toHaveBeenLastCalledWith({ ...NO_DOCKER_STATE, pending });
  },
);

// Component layer: a plan response controls both the mismatch note and the emitted selection.
import { render, screen, waitFor } from '@testing-library/react';
import type { DockerPlan } from '@/modules/remotes/docker/docker-plan.dto';
import { apiFetch } from '@/ui/lib/api-transport';
import { ConnectDockerSection, NO_DOCKER_STATE } from './ConnectDockerSection';

jest.mock('@/ui/lib/api-transport', () => ({ HOME_BACKEND: 'home', apiFetch: jest.fn() }));

it('explains unknown user ids without advising account removal', async () => {
  const plan: DockerPlan = {
    projectId: 'p1',
    remoteId: 'r1',
    scannedAt: '',
    availability: {
      available: false,
      side: 'remote',
      reason: { code: 'vm-user-mismatch', message: 'Old VM-wide warning' },
      userMismatch: {
        homeUid: 1000,
        homeGid: 1000,
        vmUid: null,
        vmGid: null,
        uidConflict: { requestedUid: 1000, holder: 'ubuntu' },
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
      onStateChange={onStateChange}
    />,
  );
  const note = await screen.findByRole('note', { name: 'Docker availability' });
  expect(note).toHaveTextContent(
    'Docker cannot determine the user ids on this PC and the VM. Refresh the VM information and try again.',
  );
  expect(note).not.toHaveTextContent('remove ubuntu');
  await waitFor(() =>
    expect(onStateChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ items: [], ready: false, pending: false }),
    ),
  );
});

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

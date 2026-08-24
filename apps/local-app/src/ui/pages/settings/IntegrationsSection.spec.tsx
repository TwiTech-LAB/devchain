import { render, screen } from '@testing-library/react';
import { disconnectedConnectionState } from '@/ui/lib/integration-connections';
import { useIntegrationAvailability } from '@/ui/hooks/useIntegrationAvailability';
import { useIntegrationConnections } from '@/ui/hooks/useIntegrationConnections';
import { useManagedSubtaskSyncHealth } from '@/ui/hooks/useManagedSubtaskSyncHealth';
import { IntegrationsSection } from './IntegrationsSection';

jest.mock('@/ui/hooks/useIntegrationAvailability');
jest.mock('@/ui/hooks/useIntegrationConnections');
jest.mock('@/ui/hooks/useManagedSubtaskSyncHealth');

const useAvailabilityMock = useIntegrationAvailability as jest.MockedFunction<
  typeof useIntegrationAvailability
>;
const useConnectionsMock = useIntegrationConnections as jest.MockedFunction<
  typeof useIntegrationConnections
>;
const useHealthMock = useManagedSubtaskSyncHealth as jest.MockedFunction<
  typeof useManagedSubtaskSyncHealth
>;

describe('IntegrationsSection', () => {
  it('shows the same off-by-default managed-subtask option in disconnected Settings forms', () => {
    useAvailabilityMock.mockReturnValue({ canUseIntegrations: true, reason: null });
    useConnectionsMock.mockReturnValue({
      connections: [disconnectedConnectionState('clickup'), disconnectedConnectionState('jira')],
      isLoading: false,
      error: null,
      replaceConnection: jest.fn(),
      disconnectConnection: jest.fn(),
      updateSubtaskSync: jest.fn(),
      replacingProvider: undefined,
      disconnectingProvider: undefined,
      updatingSyncProvider: undefined,
    });
    useHealthMock.mockReturnValue({
      health: undefined,
      isLoading: false,
      error: null,
      verify: jest.fn(),
      retry: jest.fn(),
      pendingAction: undefined,
    });

    render(<IntegrationsSection />);

    const switches = screen.getAllByRole('switch', {
      name: 'Sync DevChain sub-epics as managed subtasks',
    });
    expect(switches).toHaveLength(2);
    for (const control of switches) {
      expect(control).not.toBeChecked();
    }
  });
});

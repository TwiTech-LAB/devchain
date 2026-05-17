import type { Agent } from '../../src/modules/storage/models/domain.models';

export function createMockAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-test-1',
    projectId: 'project-test-1',
    profileId: 'profile-test-1',
    providerConfigId: 'config-test-1',
    modelOverride: null,
    name: 'Test Agent',
    description: null,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

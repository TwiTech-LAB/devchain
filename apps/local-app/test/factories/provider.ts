import type { Provider } from '../../src/modules/storage/models/domain.models';

export function createMockProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: 'provider-test-1',
    name: 'claude',
    binPath: '/usr/local/bin/claude',
    mcpConfigured: false,
    mcpEndpoint: null,
    mcpRegisteredAt: null,
    autoCompactThreshold: null,
    autoCompactThreshold1m: null,
    oneMillionContextEnabled: false,
    env: null,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

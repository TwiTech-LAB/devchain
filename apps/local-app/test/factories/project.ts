import type { Project } from '../../src/modules/storage/models/domain.models';

export function createMockProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'project-test-1',
    name: 'Test Project',
    description: null,
    rootPath: '/tmp/test-project',
    isTemplate: false,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

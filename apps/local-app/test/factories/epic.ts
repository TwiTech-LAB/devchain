import type { Epic } from '../../src/modules/storage/models/domain.models';

export function createMockEpic(overrides: Partial<Epic> = {}): Epic {
  return {
    id: 'epic-test-1',
    projectId: 'project-test-1',
    title: 'Test Epic',
    description: null,
    statusId: 'status-test-1',
    parentId: null,
    agentId: null,
    version: 1,
    data: null,
    skillsRequired: null,
    tags: [],
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

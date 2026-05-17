import type { SessionDto } from '../../src/modules/sessions/dtos/sessions.dto';

export function createMockSession(overrides: Partial<SessionDto> = {}): SessionDto {
  return {
    id: 'session-test-1',
    epicId: null,
    agentId: 'agent-test-1',
    tmuxSessionId: 'tmux-test-1',
    status: 'running',
    startedAt: '2024-01-01T00:00:00Z',
    endedAt: null,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

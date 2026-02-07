import { Test, TestingModule } from '@nestjs/testing';
import { WatcherRunnerService } from './watcher-runner.service';
import { STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import { SessionsService } from '../../sessions/services/sessions.service';
import { TmuxService } from '../../terminal/services/tmux.service';
import { EventsService } from '../../events/services/events.service';
import type { Watcher } from '../../storage/models/domain.models';
import type { SessionDto } from '../../sessions/dtos/sessions.dto';

describe('WatcherRunnerService', () => {
  let service: WatcherRunnerService;
  let mockStorage: {
    listEnabledWatchers: jest.Mock;
    getWatcher: jest.Mock;
    listAgents: jest.Mock;
    getAgentProfile: jest.Mock;
    getProfileProviderConfig: jest.Mock;
    getAgent: jest.Mock;
  };
  let mockSessionsService: {
    listActiveSessions: jest.Mock;
  };
  let mockTmuxService: {
    capturePane: jest.Mock;
  };
  let mockEventsService: {
    publish: jest.Mock;
  };

  const createMockSession = (overrides: Partial<SessionDto> = {}): SessionDto => ({
    id: 'session-1',
    epicId: null,
    agentId: 'agent-1',
    tmuxSessionId: 'tmux-session-1',
    status: 'running',
    startedAt: '2024-01-01T00:00:00Z',
    endedAt: null,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    ...overrides,
  });

  const createMockWatcher = (overrides: Partial<Watcher> = {}): Watcher => ({
    id: 'watcher-1',
    projectId: 'project-1',
    name: 'Test Watcher',
    description: null,
    enabled: true,
    scope: 'all',
    scopeFilterId: null,
    pollIntervalMs: 1000,
    viewportLines: 50,
    idleAfterSeconds: 0,
    condition: { type: 'contains', pattern: 'error' },
    cooldownMs: 5000,
    cooldownMode: 'time',
    eventName: 'test.event',
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    ...overrides,
  });

  beforeEach(async () => {
    mockStorage = {
      listEnabledWatchers: jest.fn().mockResolvedValue([]),
      getWatcher: jest.fn(),
      listAgents: jest.fn().mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 }),
      getAgentProfile: jest.fn(),
      getProfileProviderConfig: jest.fn(),
      listProfileProviderConfigsByProfile: jest.fn().mockResolvedValue([]),
      getAgent: jest.fn().mockResolvedValue(null),
    };

    mockSessionsService = {
      listActiveSessions: jest.fn().mockResolvedValue([]),
    };

    mockTmuxService = {
      capturePane: jest.fn().mockResolvedValue(''),
    };

    mockEventsService = {
      publish: jest.fn().mockResolvedValue('event-id-123'),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WatcherRunnerService,
        {
          provide: STORAGE_SERVICE,
          useValue: mockStorage,
        },
        {
          provide: SessionsService,
          useValue: mockSessionsService,
        },
        {
          provide: TmuxService,
          useValue: mockTmuxService,
        },
        {
          provide: EventsService,
          useValue: mockEventsService,
        },
      ],
    }).compile();

    service = module.get<WatcherRunnerService>(WatcherRunnerService);
  });

  describe('getMatchingSessions', () => {
    describe('scope: all', () => {
      it('should return all active sessions for the project', async () => {
        const sessions = [
          createMockSession({ id: 'session-1', agentId: 'agent-1' }),
          createMockSession({ id: 'session-2', agentId: 'agent-2' }),
          createMockSession({ id: 'session-3', agentId: null }),
        ];
        mockSessionsService.listActiveSessions.mockResolvedValue(sessions);

        const watcher = createMockWatcher({ scope: 'all' });
        const result = await service.getMatchingSessions(watcher);

        expect(result).toEqual(sessions);
        expect(mockSessionsService.listActiveSessions).toHaveBeenCalledWith('project-1');
      });

      it('should return empty array if no active sessions', async () => {
        mockSessionsService.listActiveSessions.mockResolvedValue([]);

        const watcher = createMockWatcher({ scope: 'all' });
        const result = await service.getMatchingSessions(watcher);

        expect(result).toEqual([]);
      });
    });

    describe('scope: agent', () => {
      it('should filter sessions by exact agentId match', async () => {
        const sessions = [
          createMockSession({ id: 'session-1', agentId: 'agent-1' }),
          createMockSession({ id: 'session-2', agentId: 'agent-2' }),
          createMockSession({ id: 'session-3', agentId: 'agent-1' }),
        ];
        mockSessionsService.listActiveSessions.mockResolvedValue(sessions);

        const watcher = createMockWatcher({ scope: 'agent', scopeFilterId: 'agent-1' });
        const result = await service.getMatchingSessions(watcher);

        expect(result).toHaveLength(2);
        expect(result.map((s) => s.id)).toEqual(['session-1', 'session-3']);
      });

      it('should exclude sessions without agentId', async () => {
        const sessions = [
          createMockSession({ id: 'session-1', agentId: 'agent-1' }),
          createMockSession({ id: 'session-2', agentId: null }),
        ];
        mockSessionsService.listActiveSessions.mockResolvedValue(sessions);

        const watcher = createMockWatcher({ scope: 'agent', scopeFilterId: 'agent-1' });
        const result = await service.getMatchingSessions(watcher);

        expect(result).toHaveLength(1);
        expect(result[0].id).toBe('session-1');
      });

      it('should return empty array if no matching agentId', async () => {
        const sessions = [
          createMockSession({ id: 'session-1', agentId: 'agent-1' }),
          createMockSession({ id: 'session-2', agentId: 'agent-2' }),
        ];
        mockSessionsService.listActiveSessions.mockResolvedValue(sessions);

        const watcher = createMockWatcher({ scope: 'agent', scopeFilterId: 'agent-999' });
        const result = await service.getMatchingSessions(watcher);

        expect(result).toEqual([]);
      });
    });

    describe('scope: profile', () => {
      it('should filter sessions via agent -> profile lookup', async () => {
        const sessions = [
          createMockSession({ id: 'session-1', agentId: 'agent-1' }),
          createMockSession({ id: 'session-2', agentId: 'agent-2' }),
          createMockSession({ id: 'session-3', agentId: 'agent-3' }),
        ];
        mockSessionsService.listActiveSessions.mockResolvedValue(sessions);

        mockStorage.listAgents.mockResolvedValue({
          items: [
            { id: 'agent-1', profileId: 'profile-A', projectId: 'project-1', name: 'Agent 1' },
            { id: 'agent-2', profileId: 'profile-B', projectId: 'project-1', name: 'Agent 2' },
            { id: 'agent-3', profileId: 'profile-A', projectId: 'project-1', name: 'Agent 3' },
          ],
          total: 3,
          limit: 100,
          offset: 0,
        });

        const watcher = createMockWatcher({ scope: 'profile', scopeFilterId: 'profile-A' });
        const result = await service.getMatchingSessions(watcher);

        expect(result).toHaveLength(2);
        expect(result.map((s) => s.id)).toEqual(['session-1', 'session-3']);
      });

      it('should exclude sessions without agentId', async () => {
        const sessions = [
          createMockSession({ id: 'session-1', agentId: 'agent-1' }),
          createMockSession({ id: 'session-2', agentId: null }),
        ];
        mockSessionsService.listActiveSessions.mockResolvedValue(sessions);

        mockStorage.listAgents.mockResolvedValue({
          items: [
            { id: 'agent-1', profileId: 'profile-A', projectId: 'project-1', name: 'Agent 1' },
          ],
          total: 1,
          limit: 100,
          offset: 0,
        });

        const watcher = createMockWatcher({ scope: 'profile', scopeFilterId: 'profile-A' });
        const result = await service.getMatchingSessions(watcher);

        expect(result).toHaveLength(1);
        expect(result[0].id).toBe('session-1');
      });

      it('should return empty array if no agents with matching profileId', async () => {
        const sessions = [createMockSession({ id: 'session-1', agentId: 'agent-1' })];
        mockSessionsService.listActiveSessions.mockResolvedValue(sessions);

        mockStorage.listAgents.mockResolvedValue({
          items: [
            { id: 'agent-1', profileId: 'profile-B', projectId: 'project-1', name: 'Agent 1' },
          ],
          total: 1,
          limit: 100,
          offset: 0,
        });

        const watcher = createMockWatcher({ scope: 'profile', scopeFilterId: 'profile-A' });
        const result = await service.getMatchingSessions(watcher);

        expect(result).toEqual([]);
      });
    });

    describe('scope: provider', () => {
      it('should filter sessions via agent -> profile -> provider lookup', async () => {
        const sessions = [
          createMockSession({ id: 'session-1', agentId: 'agent-1' }),
          createMockSession({ id: 'session-2', agentId: 'agent-2' }),
          createMockSession({ id: 'session-3', agentId: 'agent-3' }),
        ];
        mockSessionsService.listActiveSessions.mockResolvedValue(sessions);

        mockStorage.listAgents.mockResolvedValue({
          items: [
            { id: 'agent-1', profileId: 'profile-A', projectId: 'project-1', name: 'Agent 1' },
            { id: 'agent-2', profileId: 'profile-B', projectId: 'project-1', name: 'Agent 2' },
            { id: 'agent-3', profileId: 'profile-C', projectId: 'project-1', name: 'Agent 3' },
          ],
          total: 3,
          limit: 100,
          offset: 0,
        });

        // Provider info now comes from configs (Phase 4)
        mockStorage.listProfileProviderConfigsByProfile
          .mockResolvedValueOnce([
            { id: 'config-A', profileId: 'profile-A', providerId: 'provider-X' },
          ])
          .mockResolvedValueOnce([
            { id: 'config-B', profileId: 'profile-B', providerId: 'provider-Y' },
          ])
          .mockResolvedValueOnce([
            { id: 'config-C', profileId: 'profile-C', providerId: 'provider-X' },
          ]);

        const watcher = createMockWatcher({ scope: 'provider', scopeFilterId: 'provider-X' });
        const result = await service.getMatchingSessions(watcher);

        expect(result).toHaveLength(2);
        expect(result.map((s) => s.id)).toEqual(['session-1', 'session-3']);
      });

      it('should cache profile lookups within a poll cycle', async () => {
        const sessions = [
          createMockSession({ id: 'session-1', agentId: 'agent-1' }),
          createMockSession({ id: 'session-2', agentId: 'agent-2' }),
        ];
        mockSessionsService.listActiveSessions.mockResolvedValue(sessions);

        // Both agents use the same profile
        mockStorage.listAgents.mockResolvedValue({
          items: [
            { id: 'agent-1', profileId: 'profile-A', projectId: 'project-1', name: 'Agent 1' },
            { id: 'agent-2', profileId: 'profile-A', projectId: 'project-1', name: 'Agent 2' },
          ],
          total: 2,
          limit: 100,
          offset: 0,
        });

        // Provider info now from configs
        mockStorage.listProfileProviderConfigsByProfile.mockResolvedValue([
          { id: 'config-A', profileId: 'profile-A', providerId: 'provider-X' },
        ]);

        const watcher = createMockWatcher({ scope: 'provider', scopeFilterId: 'provider-X' });
        await service.getMatchingSessions(watcher);

        // Configs should only be fetched once per profile due to caching
        expect(mockStorage.listProfileProviderConfigsByProfile).toHaveBeenCalledTimes(1);
      });

      it('should exclude sessions without agentId', async () => {
        const sessions = [
          createMockSession({ id: 'session-1', agentId: 'agent-1' }),
          createMockSession({ id: 'session-2', agentId: null }),
        ];
        mockSessionsService.listActiveSessions.mockResolvedValue(sessions);

        mockStorage.listAgents.mockResolvedValue({
          items: [
            { id: 'agent-1', profileId: 'profile-A', projectId: 'project-1', name: 'Agent 1' },
          ],
          total: 1,
          limit: 100,
          offset: 0,
        });

        // Provider info from configs
        mockStorage.listProfileProviderConfigsByProfile.mockResolvedValue([
          { id: 'config-A', profileId: 'profile-A', providerId: 'provider-X' },
        ]);

        const watcher = createMockWatcher({ scope: 'provider', scopeFilterId: 'provider-X' });
        const result = await service.getMatchingSessions(watcher);

        expect(result).toHaveLength(1);
        expect(result[0].id).toBe('session-1');
      });

      it('should skip agents with missing configs', async () => {
        const sessions = [
          createMockSession({ id: 'session-1', agentId: 'agent-1' }),
          createMockSession({ id: 'session-2', agentId: 'agent-2' }),
        ];
        mockSessionsService.listActiveSessions.mockResolvedValue(sessions);

        mockStorage.listAgents.mockResolvedValue({
          items: [
            { id: 'agent-1', profileId: 'profile-A', projectId: 'project-1', name: 'Agent 1' },
            {
              id: 'agent-2',
              profileId: 'profile-missing',
              projectId: 'project-1',
              name: 'Agent 2',
            },
          ],
          total: 2,
          limit: 100,
          offset: 0,
        });

        // Config lookup fails for profile-missing
        mockStorage.listProfileProviderConfigsByProfile
          .mockResolvedValueOnce([
            { id: 'config-A', profileId: 'profile-A', providerId: 'provider-X' },
          ])
          .mockRejectedValueOnce(new Error('Profile not found'));

        const watcher = createMockWatcher({ scope: 'provider', scopeFilterId: 'provider-X' });
        const result = await service.getMatchingSessions(watcher);

        // Only agent-1 should be included (agent-2's config lookup failed)
        expect(result).toHaveLength(1);
        expect(result[0].id).toBe('session-1');
      });

      it('should return empty array if no agents with matching providerId', async () => {
        const sessions = [createMockSession({ id: 'session-1', agentId: 'agent-1' })];
        mockSessionsService.listActiveSessions.mockResolvedValue(sessions);

        mockStorage.listAgents.mockResolvedValue({
          items: [
            { id: 'agent-1', profileId: 'profile-A', projectId: 'project-1', name: 'Agent 1' },
          ],
          total: 1,
          limit: 100,
          offset: 0,
        });

        mockStorage.getAgentProfile.mockResolvedValue({
          id: 'profile-A',
          providerId: 'provider-Y',
        });

        const watcher = createMockWatcher({ scope: 'provider', scopeFilterId: 'provider-X' });
        const result = await service.getMatchingSessions(watcher);

        expect(result).toEqual([]);
      });

      it('should use providerConfigId when available', async () => {
        const sessions = [
          createMockSession({ id: 'session-1', agentId: 'agent-1' }),
          createMockSession({ id: 'session-2', agentId: 'agent-2' }),
        ];
        mockSessionsService.listActiveSessions.mockResolvedValue(sessions);

        mockStorage.listAgents.mockResolvedValue({
          items: [
            {
              id: 'agent-1',
              profileId: 'profile-A',
              providerConfigId: 'config-1',
              projectId: 'project-1',
              name: 'Agent 1',
            },
            {
              id: 'agent-2',
              profileId: 'profile-A',
              providerConfigId: 'config-2',
              projectId: 'project-1',
              name: 'Agent 2',
            },
          ],
          total: 2,
          limit: 100,
          offset: 0,
        });

        mockStorage.getProfileProviderConfig
          .mockResolvedValueOnce({
            id: 'config-1',
            profileId: 'profile-A',
            providerId: 'provider-X',
          })
          .mockResolvedValueOnce({
            id: 'config-2',
            profileId: 'profile-A',
            providerId: 'provider-Y',
          });

        const watcher = createMockWatcher({ scope: 'provider', scopeFilterId: 'provider-X' });
        const result = await service.getMatchingSessions(watcher);

        expect(mockStorage.getProfileProviderConfig).toHaveBeenCalledTimes(2);
        expect(mockStorage.getAgentProfile).not.toHaveBeenCalled();
        expect(result).toHaveLength(1);
        expect(result[0].id).toBe('session-1');
      });

      it('should fall back to profile configs when providerConfigId lookup fails', async () => {
        const sessions = [createMockSession({ id: 'session-1', agentId: 'agent-1' })];
        mockSessionsService.listActiveSessions.mockResolvedValue(sessions);

        mockStorage.listAgents.mockResolvedValue({
          items: [
            {
              id: 'agent-1',
              profileId: 'profile-A',
              providerConfigId: 'config-missing',
              projectId: 'project-1',
              name: 'Agent 1',
            },
          ],
          total: 1,
          limit: 100,
          offset: 0,
        });

        // Direct config lookup fails
        mockStorage.getProfileProviderConfig.mockRejectedValue(new Error('Config not found'));
        // Fallback to profile's configs (Phase 4 behavior)
        mockStorage.listProfileProviderConfigsByProfile.mockResolvedValue([
          { id: 'config-A', profileId: 'profile-A', providerId: 'provider-X' },
        ]);

        const watcher = createMockWatcher({ scope: 'provider', scopeFilterId: 'provider-X' });
        const result = await service.getMatchingSessions(watcher);

        expect(mockStorage.getProfileProviderConfig).toHaveBeenCalledWith('config-missing');
        expect(mockStorage.listProfileProviderConfigsByProfile).toHaveBeenCalledWith('profile-A');
        expect(result).toHaveLength(1);
        expect(result[0].id).toBe('session-1');
      });

      it('should cache config lookups within a poll cycle', async () => {
        const sessions = [
          createMockSession({ id: 'session-1', agentId: 'agent-1' }),
          createMockSession({ id: 'session-2', agentId: 'agent-2' }),
        ];
        mockSessionsService.listActiveSessions.mockResolvedValue(sessions);

        // Both agents use the same config
        mockStorage.listAgents.mockResolvedValue({
          items: [
            {
              id: 'agent-1',
              profileId: 'profile-A',
              providerConfigId: 'config-1',
              projectId: 'project-1',
              name: 'Agent 1',
            },
            {
              id: 'agent-2',
              profileId: 'profile-A',
              providerConfigId: 'config-1',
              projectId: 'project-1',
              name: 'Agent 2',
            },
          ],
          total: 2,
          limit: 100,
          offset: 0,
        });

        mockStorage.getProfileProviderConfig.mockResolvedValue({
          id: 'config-1',
          profileId: 'profile-A',
          providerId: 'provider-X',
        });

        const watcher = createMockWatcher({ scope: 'provider', scopeFilterId: 'provider-X' });
        await service.getMatchingSessions(watcher);

        // Config should only be fetched once due to caching
        expect(mockStorage.getProfileProviderConfig).toHaveBeenCalledTimes(1);
      });

      it('should cache profile lookups for profiles without configs (undefined providerId)', async () => {
        const sessions = [
          createMockSession({ id: 'session-1', agentId: 'agent-1' }),
          createMockSession({ id: 'session-2', agentId: 'agent-2' }),
          createMockSession({ id: 'session-3', agentId: 'agent-3' }),
        ];
        mockSessionsService.listActiveSessions.mockResolvedValue(sessions);

        // All agents use the same profile but have no providerConfigId
        // This triggers the fallback path via listProfileProviderConfigsByProfile
        mockStorage.listAgents.mockResolvedValue({
          items: [
            {
              id: 'agent-1',
              profileId: 'profile-no-configs',
              providerConfigId: null,
              projectId: 'project-1',
              name: 'Agent 1',
            },
            {
              id: 'agent-2',
              profileId: 'profile-no-configs',
              providerConfigId: null,
              projectId: 'project-1',
              name: 'Agent 2',
            },
            {
              id: 'agent-3',
              profileId: 'profile-no-configs',
              providerConfigId: null,
              projectId: 'project-1',
              name: 'Agent 3',
            },
          ],
          total: 3,
          limit: 100,
          offset: 0,
        });

        // Profile has no configs, so providerId will be undefined
        mockStorage.listProfileProviderConfigsByProfile.mockResolvedValue([]);

        const watcher = createMockWatcher({ scope: 'provider', scopeFilterId: 'provider-X' });
        await service.getMatchingSessions(watcher);

        // Profile configs should only be fetched ONCE despite 3 agents sharing the same profile
        // This verifies the cache correctly handles undefined providerId values
        expect(mockStorage.listProfileProviderConfigsByProfile).toHaveBeenCalledTimes(1);
        expect(mockStorage.listProfileProviderConfigsByProfile).toHaveBeenCalledWith(
          'profile-no-configs',
        );
      });
    });

    describe('empty results', () => {
      it('should return empty array (not error) when no sessions match', async () => {
        mockSessionsService.listActiveSessions.mockResolvedValue([]);

        const watcher = createMockWatcher({ scope: 'agent', scopeFilterId: 'agent-1' });
        const result = await service.getMatchingSessions(watcher);

        expect(result).toEqual([]);
        expect(Array.isArray(result)).toBe(true);
      });
    });
  });

  describe('captureViewport', () => {
    const tmuxSessionId = 'test-tmux-session';
    const lines = 50;

    describe('cache miss', () => {
      it('should call tmux and cache result on cache miss', async () => {
        const capturedText = 'Hello, terminal world!';
        mockTmuxService.capturePane.mockResolvedValue(capturedText);

        const result = await service.captureViewport(tmuxSessionId, lines);

        expect(result).toBe(capturedText);
        expect(mockTmuxService.capturePane).toHaveBeenCalledWith(tmuxSessionId, lines, false);
        expect(mockTmuxService.capturePane).toHaveBeenCalledTimes(1);
      });

      it('should store captured text in cache', async () => {
        const capturedText = 'Cached content';
        mockTmuxService.capturePane.mockResolvedValue(capturedText);

        await service.captureViewport(tmuxSessionId, lines);

        // Verify cache was populated
        const cached = service.getCachedCapture(tmuxSessionId, lines);
        expect(cached).toBe(capturedText);
      });
    });

    describe('cache hit', () => {
      it('should return cached value without calling tmux', async () => {
        const cachedText = 'Pre-cached content';
        service.setCachedCapture(tmuxSessionId, lines, cachedText);

        const result = await service.captureViewport(tmuxSessionId, lines);

        expect(result).toBe(cachedText);
        expect(mockTmuxService.capturePane).not.toHaveBeenCalled();
      });

      it('should use different cache keys for different line counts', async () => {
        service.setCachedCapture(tmuxSessionId, 50, 'Content for 50 lines');
        service.setCachedCapture(tmuxSessionId, 100, 'Content for 100 lines');

        const result50 = await service.captureViewport(tmuxSessionId, 50);
        const result100 = await service.captureViewport(tmuxSessionId, 100);

        expect(result50).toBe('Content for 50 lines');
        expect(result100).toBe('Content for 100 lines');
        expect(mockTmuxService.capturePane).not.toHaveBeenCalled();
      });
    });

    describe('cache expiry', () => {
      it('should call tmux when cache is expired', async () => {
        // Manually set an expired cache entry
        const key = `${tmuxSessionId}:${lines}`;
        // Access private captureCache via any cast for testing
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (service as any).captureCache.set(key, { text: 'Old content', ts: Date.now() - 3000 });

        const freshText = 'Fresh content';
        mockTmuxService.capturePane.mockResolvedValue(freshText);

        const result = await service.captureViewport(tmuxSessionId, lines);

        expect(result).toBe(freshText);
        expect(mockTmuxService.capturePane).toHaveBeenCalledTimes(1);
      });
    });

    describe('error handling', () => {
      it('should return empty string on tmux error', async () => {
        mockTmuxService.capturePane.mockRejectedValue(new Error('tmux not found'));

        const result = await service.captureViewport(tmuxSessionId, lines);

        expect(result).toBe('');
      });

      it('should not cache failed captures', async () => {
        mockTmuxService.capturePane.mockRejectedValue(new Error('tmux error'));

        await service.captureViewport(tmuxSessionId, lines);

        const cached = service.getCachedCapture(tmuxSessionId, lines);
        expect(cached).toBeNull();
      });
    });

    describe('ANSI stripping', () => {
      it('should call capturePane with includeEscapes=false', async () => {
        mockTmuxService.capturePane.mockResolvedValue('text');

        await service.captureViewport(tmuxSessionId, lines);

        // Third argument should be false to strip ANSI codes
        expect(mockTmuxService.capturePane).toHaveBeenCalledWith(tmuxSessionId, lines, false);
      });
    });
  });

  describe('getCachedCapture', () => {
    it('should return null on cache miss', () => {
      const result = service.getCachedCapture('non-existent', 50);
      expect(result).toBeNull();
    });

    it('should return cached text within TTL', () => {
      service.setCachedCapture('session-1', 50, 'cached text');
      const result = service.getCachedCapture('session-1', 50);
      expect(result).toBe('cached text');
    });

    it('should return null and delete expired cache', () => {
      const key = 'session-1:50';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (service as any).captureCache.set(key, { text: 'expired', ts: Date.now() - 3000 });

      const result = service.getCachedCapture('session-1', 50);
      expect(result).toBeNull();

      // Verify it was deleted
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((service as any).captureCache.has(key)).toBe(false);
    });
  });

  describe('clearCaptureCache', () => {
    it('should clear all cached captures', () => {
      service.setCachedCapture('session-1', 50, 'text 1');
      service.setCachedCapture('session-2', 100, 'text 2');

      service.clearCaptureCache();

      expect(service.getCachedCapture('session-1', 50)).toBeNull();
      expect(service.getCachedCapture('session-2', 100)).toBeNull();
    });
  });

  describe('matchCondition', () => {
    describe('contains', () => {
      it('should return true when pattern is found in text', () => {
        const condition = { type: 'contains' as const, pattern: 'error' };
        expect(service.matchCondition(condition, 'An error occurred')).toBe(true);
      });

      it('should return false when pattern is not found', () => {
        const condition = { type: 'contains' as const, pattern: 'error' };
        expect(service.matchCondition(condition, 'Everything is fine')).toBe(false);
      });

      it('should be case-sensitive by default', () => {
        const condition = { type: 'contains' as const, pattern: 'Error' };
        expect(service.matchCondition(condition, 'error')).toBe(false);
        expect(service.matchCondition(condition, 'Error')).toBe(true);
      });

      it('should match empty text when pattern is empty string', () => {
        const condition = { type: 'contains' as const, pattern: '' };
        expect(service.matchCondition(condition, '')).toBe(true);
        expect(service.matchCondition(condition, 'any text')).toBe(true);
      });

      it('should handle special characters in pattern', () => {
        const condition = { type: 'contains' as const, pattern: '[error]' };
        expect(service.matchCondition(condition, 'Log: [error] message')).toBe(true);
        expect(service.matchCondition(condition, 'Log: error message')).toBe(false);
      });
    });

    describe('regex', () => {
      it('should match using regex pattern', () => {
        const condition = { type: 'regex' as const, pattern: 'error|warning' };
        expect(service.matchCondition(condition, 'An error occurred')).toBe(true);
        expect(service.matchCondition(condition, 'A warning appeared')).toBe(true);
        expect(service.matchCondition(condition, 'Everything is fine')).toBe(false);
      });

      it('should support case-insensitive flag', () => {
        const condition = { type: 'regex' as const, pattern: 'error', flags: 'i' };
        expect(service.matchCondition(condition, 'ERROR')).toBe(true);
        expect(service.matchCondition(condition, 'Error')).toBe(true);
        expect(service.matchCondition(condition, 'error')).toBe(true);
      });

      it('should support multiline flag', () => {
        const condition = { type: 'regex' as const, pattern: '^error', flags: 'm' };
        const text = 'line1\nerror on line2';
        expect(service.matchCondition(condition, text)).toBe(true);
      });

      it('should support global flag', () => {
        const condition = { type: 'regex' as const, pattern: 'error', flags: 'g' };
        expect(service.matchCondition(condition, 'error error error')).toBe(true);
      });

      it('should support combined flags', () => {
        const condition = { type: 'regex' as const, pattern: '^error', flags: 'im' };
        const text = 'line1\nERROR on line2';
        expect(service.matchCondition(condition, text)).toBe(true);
      });

      it('should return false for invalid regex pattern', () => {
        const condition = { type: 'regex' as const, pattern: '[invalid(' };
        expect(service.matchCondition(condition, 'any text')).toBe(false);
      });

      it('should handle complex regex patterns', () => {
        const condition = { type: 'regex' as const, pattern: '\\d{3}-\\d{4}' };
        expect(service.matchCondition(condition, 'Phone: 123-4567')).toBe(true);
        expect(service.matchCondition(condition, 'Phone: 12-345')).toBe(false);
      });

      it('should match with no flags when flags is undefined', () => {
        const condition = { type: 'regex' as const, pattern: 'test' };
        expect(service.matchCondition(condition, 'this is a test')).toBe(true);
      });
    });

    describe('not_contains', () => {
      it('should return true when pattern is NOT found', () => {
        const condition = { type: 'not_contains' as const, pattern: 'error' };
        expect(service.matchCondition(condition, 'Everything is fine')).toBe(true);
      });

      it('should return false when pattern IS found', () => {
        const condition = { type: 'not_contains' as const, pattern: 'error' };
        expect(service.matchCondition(condition, 'An error occurred')).toBe(false);
      });

      it('should be case-sensitive', () => {
        const condition = { type: 'not_contains' as const, pattern: 'Error' };
        expect(service.matchCondition(condition, 'error')).toBe(true);
        expect(service.matchCondition(condition, 'Error')).toBe(false);
      });

      it('should return false for empty pattern (always contained)', () => {
        const condition = { type: 'not_contains' as const, pattern: '' };
        expect(service.matchCondition(condition, 'any text')).toBe(false);
      });
    });

    describe('edge cases', () => {
      it('should handle empty text', () => {
        expect(service.matchCondition({ type: 'contains', pattern: 'test' }, '')).toBe(false);
        expect(service.matchCondition({ type: 'not_contains', pattern: 'test' }, '')).toBe(true);
        expect(service.matchCondition({ type: 'regex', pattern: 'test' }, '')).toBe(false);
      });

      it('should handle very long text', () => {
        const longText = 'a'.repeat(10000) + 'error' + 'a'.repeat(10000);
        const condition = { type: 'contains' as const, pattern: 'error' };
        expect(service.matchCondition(condition, longText)).toBe(true);
      });

      it('should handle newlines in text', () => {
        const text = 'line1\nline2\nerror\nline4';
        const condition = { type: 'contains' as const, pattern: 'error' };
        expect(service.matchCondition(condition, text)).toBe(true);
      });

      it('should handle unicode characters', () => {
        const condition = { type: 'contains' as const, pattern: '错误' };
        expect(service.matchCondition(condition, '发生了错误')).toBe(true);
      });

      it('should return false for unknown condition type', () => {
        const condition = { type: 'unknown' as 'contains', pattern: 'test' };
        expect(service.matchCondition(condition, 'test')).toBe(false);
      });
    });
  });

  describe('computeViewportHash', () => {
    it('should return a 16-character hex string', () => {
      const hash = service.computeViewportHash('test content');
      expect(hash).toHaveLength(16);
      expect(hash).toMatch(/^[0-9a-f]{16}$/);
    });

    it('should return consistent hash for same content', () => {
      const hash1 = service.computeViewportHash('same content');
      const hash2 = service.computeViewportHash('same content');
      expect(hash1).toBe(hash2);
    });

    it('should return different hash for different content', () => {
      const hash1 = service.computeViewportHash('content A');
      const hash2 = service.computeViewportHash('content B');
      expect(hash1).not.toBe(hash2);
    });

    it('should handle empty string', () => {
      const hash = service.computeViewportHash('');
      expect(hash).toHaveLength(16);
    });

    it('should handle unicode content', () => {
      const hash = service.computeViewportHash('中文内容');
      expect(hash).toHaveLength(16);
    });
  });

  describe('checkTriggerEligibility', () => {
    const createTestWatcher = (overrides: Partial<Watcher> = {}): Watcher => ({
      id: 'watcher-1',
      projectId: 'project-1',
      name: 'Test Watcher',
      description: null,
      enabled: true,
      scope: 'all',
      scopeFilterId: null,
      pollIntervalMs: 1000,
      viewportLines: 50,
      idleAfterSeconds: 0,
      condition: { type: 'contains', pattern: 'error' },
      cooldownMs: 5000,
      cooldownMode: 'time',
      eventName: 'test.event',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
      ...overrides,
    });

    describe('hash-based deduplication', () => {
      it('should trigger on first match', () => {
        const watcher = createTestWatcher();
        const result = service.checkTriggerEligibility(watcher, 'session-1', 'error content', true);
        expect(result.shouldTrigger).toBe(true);
      });

      it('should NOT trigger when viewport hash unchanged', () => {
        const watcher = createTestWatcher();
        // First trigger
        service.checkTriggerEligibility(watcher, 'session-1', 'error content', true);
        // Second call with same content - should skip
        const result = service.checkTriggerEligibility(watcher, 'session-1', 'error content', true);
        expect(result.shouldTrigger).toBe(false);
      });

      it('should trigger when viewport hash changes', () => {
        const watcher = createTestWatcher({ cooldownMs: 0 }); // Disable time-based cooldown
        // First trigger
        service.checkTriggerEligibility(watcher, 'session-1', 'error content 1', true);
        // Second call with different content - should trigger
        const result = service.checkTriggerEligibility(
          watcher,
          'session-1',
          'error content 2',
          true,
        );
        expect(result.shouldTrigger).toBe(true);
      });
    });

    describe('time-based cooldown', () => {
      it('should NOT trigger during cooldown period', () => {
        const watcher = createTestWatcher({ cooldownMs: 10000 }); // 10s cooldown
        // First trigger
        service.checkTriggerEligibility(watcher, 'session-1', 'error 1', true);
        // Second call with different content but within cooldown
        const result = service.checkTriggerEligibility(watcher, 'session-1', 'error 2', true);
        expect(result.shouldTrigger).toBe(false);
      });

      it('should trigger after cooldown expires', async () => {
        const watcher = createTestWatcher({ cooldownMs: 10 }); // 10ms cooldown
        // First trigger
        service.checkTriggerEligibility(watcher, 'session-1', 'error 1', true);
        // Wait for cooldown to expire
        await new Promise((resolve) => setTimeout(resolve, 20));
        // Should trigger again even if viewport unchanged (cooldown already throttles)
        const result = service.checkTriggerEligibility(watcher, 'session-1', 'error 1', true);
        expect(result.shouldTrigger).toBe(true);
      });
    });

    describe('until_clear cooldown mode', () => {
      it('should trigger on first false->true transition', () => {
        const watcher = createTestWatcher({ cooldownMode: 'until_clear' });
        const result = service.checkTriggerEligibility(watcher, 'session-1', 'error content', true);
        expect(result.shouldTrigger).toBe(true);
      });

      it('should NOT trigger when condition stays true', () => {
        const watcher = createTestWatcher({ cooldownMode: 'until_clear' });
        // First trigger (false -> true)
        service.checkTriggerEligibility(watcher, 'session-1', 'error 1', true);
        // Second call with condition still true (different content)
        const result = service.checkTriggerEligibility(watcher, 'session-1', 'error 2', true);
        expect(result.shouldTrigger).toBe(false);
      });

      it('should trigger again after condition clears (true->false->true)', () => {
        const watcher = createTestWatcher({ cooldownMode: 'until_clear' });
        // First trigger (false -> true)
        service.checkTriggerEligibility(watcher, 'session-1', 'error 1', true);
        // Condition becomes false - clears cooldown
        service.checkTriggerEligibility(watcher, 'session-1', 'no error', false);
        // Condition becomes true again - should trigger
        const result = service.checkTriggerEligibility(watcher, 'session-1', 'error 2', true);
        expect(result.shouldTrigger).toBe(true);
      });

      it('should clear cooldown when condition becomes false', () => {
        const watcher = createTestWatcher({ cooldownMode: 'until_clear' });
        // Trigger
        service.checkTriggerEligibility(watcher, 'session-1', 'error', true);
        // Verify cooldown is set
        expect(service.isOnCooldown('watcher-1', 'session-1')).toBe(true);
        // Condition becomes false
        service.checkTriggerEligibility(watcher, 'session-1', 'no error', false);
        // Cooldown should be cleared
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect((service as any).cooldowns.has('watcher-1:session-1')).toBe(false);
      });
    });

    describe('condition state tracking', () => {
      it('should update lastConditionState on each check', () => {
        const watcher = createTestWatcher();
        // Check with true
        service.checkTriggerEligibility(watcher, 'session-1', 'error', true);
        expect(service.getLastConditionState('watcher-1', 'session-1')).toBe(true);
        // Check with false
        service.checkTriggerEligibility(watcher, 'session-1', 'no error', false);
        expect(service.getLastConditionState('watcher-1', 'session-1')).toBe(false);
      });

      it('should return viewportHash in result', () => {
        const watcher = createTestWatcher();
        const result = service.checkTriggerEligibility(watcher, 'session-1', 'test content', true);
        expect(result.viewportHash).toHaveLength(16);
      });

      it('should set lastTriggeredHash when triggering', () => {
        const watcher = createTestWatcher();
        const result = service.checkTriggerEligibility(watcher, 'session-1', 'error', true);
        expect(service.getLastTriggeredHash('watcher-1', 'session-1')).toBe(result.viewportHash);
      });
    });

    describe('condition not matched', () => {
      it('should return shouldTrigger=false when condition not matched', () => {
        const watcher = createTestWatcher();
        const result = service.checkTriggerEligibility(watcher, 'session-1', 'no match', false);
        expect(result.shouldTrigger).toBe(false);
      });

      it('should still return viewportHash even when not triggering', () => {
        const watcher = createTestWatcher();
        const result = service.checkTriggerEligibility(watcher, 'session-1', 'no match', false);
        expect(result.viewportHash).toHaveLength(16);
      });
    });

    describe('isolation between sessions', () => {
      it('should maintain separate state for different sessions', () => {
        const watcher = createTestWatcher({ cooldownMode: 'until_clear' });
        // Trigger for session-1
        service.checkTriggerEligibility(watcher, 'session-1', 'error', true);
        // Trigger for session-2 should work independently
        const result = service.checkTriggerEligibility(watcher, 'session-2', 'error', true);
        expect(result.shouldTrigger).toBe(true);
      });
    });
  });

  describe('checkSession', () => {
    const createTestWatcher = (overrides: Partial<Watcher> = {}): Watcher => ({
      id: 'watcher-1',
      projectId: 'project-1',
      name: 'Test Watcher',
      description: null,
      enabled: true,
      scope: 'all',
      scopeFilterId: null,
      pollIntervalMs: 1000,
      viewportLines: 50,
      idleAfterSeconds: 0,
      condition: { type: 'contains', pattern: 'error' },
      cooldownMs: 5000,
      cooldownMode: 'time',
      eventName: 'test.event',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
      ...overrides,
    });

    describe('session validation', () => {
      it('should skip session without tmuxSessionId', async () => {
        const watcher = createTestWatcher();
        const session = createMockSession({ tmuxSessionId: null });

        const result = await service.checkSession(watcher, session);

        expect(result.skipped).toBe(true);
        expect(result.reason).toBe('no_tmux_session');
      });

      it('should skip session with empty viewport', async () => {
        mockTmuxService.capturePane.mockResolvedValue('');
        const watcher = createTestWatcher();
        const session = createMockSession({ tmuxSessionId: 'tmux-1' });

        const result = await service.checkSession(watcher, session);

        expect(result.skipped).toBe(true);
        expect(result.reason).toBe('empty_viewport');
      });
    });

    describe('condition matching', () => {
      it('should capture viewport and match condition', async () => {
        mockTmuxService.capturePane.mockResolvedValue('An error occurred');
        const watcher = createTestWatcher({ condition: { type: 'contains', pattern: 'error' } });
        const session = createMockSession({ tmuxSessionId: 'tmux-1' });

        const result = await service.checkSession(watcher, session);

        expect(result.skipped).toBe(false);
        expect(result.matched).toBe(true);
        expect(mockTmuxService.capturePane).toHaveBeenCalledWith('tmux-1', 50, false);
      });

      it('should not trigger when condition does not match', async () => {
        mockTmuxService.capturePane.mockResolvedValue('Everything is fine');
        const watcher = createTestWatcher({ condition: { type: 'contains', pattern: 'error' } });
        const session = createMockSession({ tmuxSessionId: 'tmux-1' });

        const result = await service.checkSession(watcher, session);

        expect(result.skipped).toBe(false);
        expect(result.matched).toBe(false);
        expect(result.triggered).toBe(false);
      });
    });

    describe('idle gate', () => {
      beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date('2024-01-01T00:10:00.000Z'));
      });

      afterEach(() => {
        jest.useRealTimers();
      });

      it('should pass idle gate and continue to viewport capture + pattern match', async () => {
        mockTmuxService.capturePane.mockResolvedValue('An error occurred');
        const watcher = createTestWatcher({
          idleAfterSeconds: 60,
          condition: { type: 'contains', pattern: 'error' },
          cooldownMs: 0,
        });
        const session = createMockSession({
          id: 'session-idle-gate-1',
          tmuxSessionId: 'tmux-1',
          activityState: 'idle',
          lastActivityAt: '2024-01-01T00:08:30.000Z',
        });

        const result = await service.checkSession(watcher, session);

        expect(result.skipped).toBe(false);
        expect(result.matched).toBe(true);
        expect(result.triggered).toBe(true);
        expect(mockTmuxService.capturePane).toHaveBeenCalledWith('tmux-1', 50, false);
        expect(mockEventsService.publish).toHaveBeenCalledTimes(1);
      });

      it('should fail idle gate when session is busy', async () => {
        const watcher = createTestWatcher({
          idleAfterSeconds: 60,
          condition: { type: 'contains', pattern: 'error' },
        });
        const session = createMockSession({
          id: 'session-idle-gate-2',
          tmuxSessionId: 'tmux-1',
          activityState: 'busy',
          lastActivityAt: '2024-01-01T00:08:30.000Z',
        });

        const result = await service.checkSession(watcher, session);

        expect(result.skipped).toBe(false);
        expect(result.matched).toBe(false);
        expect(result.triggered).toBe(false);
        expect(mockTmuxService.capturePane).not.toHaveBeenCalled();
      });

      it('should fail idle gate when lastActivityAt is missing', async () => {
        const watcher = createTestWatcher({
          idleAfterSeconds: 60,
          condition: { type: 'contains', pattern: 'error' },
        });
        const session = createMockSession({
          id: 'session-idle-gate-3',
          tmuxSessionId: 'tmux-1',
          activityState: 'idle',
          lastActivityAt: null,
        });

        const result = await service.checkSession(watcher, session);

        expect(result.skipped).toBe(false);
        expect(result.matched).toBe(false);
        expect(result.triggered).toBe(false);
        expect(mockTmuxService.capturePane).not.toHaveBeenCalled();
      });

      it('should fail idle gate when lastActivityAt is invalid', async () => {
        const watcher = createTestWatcher({
          idleAfterSeconds: 60,
          condition: { type: 'contains', pattern: 'error' },
        });
        const session = createMockSession({
          id: 'session-idle-gate-invalid-ts',
          tmuxSessionId: 'tmux-1',
          activityState: 'idle',
          lastActivityAt: 'not-a-date',
        });

        const result = await service.checkSession(watcher, session);

        expect(result.skipped).toBe(false);
        expect(result.matched).toBe(false);
        expect(result.triggered).toBe(false);
        expect(mockTmuxService.capturePane).not.toHaveBeenCalled();
      });

      it('should fail idle gate when idle duration is below threshold', async () => {
        const watcher = createTestWatcher({
          idleAfterSeconds: 60,
          condition: { type: 'contains', pattern: 'error' },
        });
        const session = createMockSession({
          id: 'session-idle-gate-not-enough',
          tmuxSessionId: 'tmux-1',
          activityState: 'idle',
          lastActivityAt: '2024-01-01T00:09:40.000Z',
        });

        const result = await service.checkSession(watcher, session);

        expect(result.skipped).toBe(false);
        expect(result.matched).toBe(false);
        expect(result.triggered).toBe(false);
        expect(mockTmuxService.capturePane).not.toHaveBeenCalled();
      });

      it('should clear until_clear cooldown when idle gate fails and trigger again after recovery', async () => {
        mockTmuxService.capturePane.mockResolvedValue('error');
        const watcher = createTestWatcher({
          idleAfterSeconds: 60,
          condition: { type: 'contains', pattern: 'error' },
          cooldownMode: 'until_clear',
        });
        const matchingSession = createMockSession({
          id: 'session-idle-gate-5',
          tmuxSessionId: 'tmux-1',
          activityState: 'idle',
          lastActivityAt: '2024-01-01T00:08:30.000Z',
        });
        const busySession = createMockSession({
          id: 'session-idle-gate-5',
          tmuxSessionId: 'tmux-1',
          activityState: 'busy',
          lastActivityAt: '2024-01-01T00:08:30.000Z',
        });

        const first = await service.checkSession(watcher, matchingSession);
        expect(first.triggered).toBe(true);
        expect(service.isOnCooldown('watcher-1', 'session-idle-gate-5')).toBe(true);
        expect(mockTmuxService.capturePane).toHaveBeenCalledTimes(1);

        const second = await service.checkSession(watcher, busySession);
        expect(second.skipped).toBe(false);
        expect(second.matched).toBe(false);
        expect(second.triggered).toBe(false);
        expect(service.isOnCooldown('watcher-1', 'session-idle-gate-5')).toBe(false);
        expect(mockTmuxService.capturePane).toHaveBeenCalledTimes(1);

        const third = await service.checkSession(watcher, matchingSession);
        expect(third.triggered).toBe(true);
        expect(mockTmuxService.capturePane).toHaveBeenCalledTimes(1);
        expect(mockEventsService.publish).toHaveBeenCalledTimes(2);
      });

      it('should not apply idle gate when idleAfterSeconds is zero', async () => {
        mockTmuxService.capturePane.mockResolvedValue('An error occurred');
        const watcher = createTestWatcher({
          idleAfterSeconds: 0,
          condition: { type: 'contains', pattern: 'error' },
          cooldownMs: 0,
        });
        const session = createMockSession({
          id: 'session-idle-gate-6',
          tmuxSessionId: 'tmux-1',
          activityState: 'busy',
          lastActivityAt: null,
        });

        const result = await service.checkSession(watcher, session);
        expect(result.skipped).toBe(false);
        expect(result.matched).toBe(true);
        expect(result.triggered).toBe(true);
        expect(mockTmuxService.capturePane).toHaveBeenCalledWith('tmux-1', 50, false);
        expect(mockEventsService.publish).toHaveBeenCalledTimes(1);
      });
    });

    describe('trigger flow', () => {
      it('should trigger when condition matches and eligible', async () => {
        mockTmuxService.capturePane.mockResolvedValue('An error occurred');
        const watcher = createTestWatcher({ cooldownMs: 0 });
        const session = createMockSession({ id: 'session-1', tmuxSessionId: 'tmux-1' });

        const result = await service.checkSession(watcher, session);

        expect(result.triggered).toBe(true);
        expect(result.viewportHash).toHaveLength(16);
      });

      it('should increment trigger count when triggered', async () => {
        mockTmuxService.capturePane.mockResolvedValue('An error occurred');
        const watcher = createTestWatcher({ cooldownMs: 0 });
        const session = createMockSession({ id: 'session-1', tmuxSessionId: 'tmux-1' });

        await service.checkSession(watcher, session);

        expect(service.getTriggerCount('watcher-1', 'session-1')).toBe(1);
      });

      it('should not trigger on duplicate content (hash dedup)', async () => {
        mockTmuxService.capturePane.mockResolvedValue('An error occurred');
        const watcher = createTestWatcher({ cooldownMs: 0 });
        const session = createMockSession({ id: 'session-1', tmuxSessionId: 'tmux-1' });

        // First check
        const result1 = await service.checkSession(watcher, session);
        expect(result1.triggered).toBe(true);

        // Second check with same content
        const result2 = await service.checkSession(watcher, session);
        expect(result2.triggered).toBe(false);
      });

      it('should use watcher.viewportLines for capture', async () => {
        mockTmuxService.capturePane.mockResolvedValue('error');
        const watcher = createTestWatcher({ viewportLines: 100 });
        const session = createMockSession({ tmuxSessionId: 'tmux-1' });

        await service.checkSession(watcher, session);

        expect(mockTmuxService.capturePane).toHaveBeenCalledWith('tmux-1', 100, false);
      });
    });

    describe('error handling', () => {
      it('should handle capturePane errors gracefully', async () => {
        mockTmuxService.capturePane.mockRejectedValue(new Error('tmux error'));
        const watcher = createTestWatcher();
        const session = createMockSession({ tmuxSessionId: 'tmux-1' });

        const result = await service.checkSession(watcher, session);

        expect(result.skipped).toBe(true);
        expect(result.reason).toBe('empty_viewport');
      });
    });
  });

  describe('inFlight guard', () => {
    it('should track watcher in inFlight during check', async () => {
      const watcher = createMockWatcher();
      mockStorage.listEnabledWatchers.mockResolvedValue([watcher]);
      mockSessionsService.listActiveSessions.mockResolvedValue([]);

      // Access private method via service
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pollWatcher = (service as any).pollWatcher.bind(service);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (service as any).watcherConfigs.set('watcher-1', watcher);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((service as any).inFlight.has('watcher-1')).toBe(false);

      const pollPromise = pollWatcher('watcher-1');

      // After poll completes
      await pollPromise;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((service as any).inFlight.has('watcher-1')).toBe(false);
    });
  });

  describe('triggerEvent', () => {
    const createTestWatcher = (overrides: Partial<Watcher> = {}): Watcher => ({
      id: 'watcher-1',
      projectId: 'project-1',
      name: 'Test Watcher',
      description: null,
      enabled: true,
      scope: 'all',
      scopeFilterId: null,
      pollIntervalMs: 1000,
      viewportLines: 50,
      idleAfterSeconds: 0,
      condition: { type: 'contains', pattern: 'error' },
      cooldownMs: 5000,
      cooldownMode: 'time',
      eventName: 'custom.watcher.event',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
      ...overrides,
    });

    describe('event publishing', () => {
      it('should publish event to terminal.watcher.triggered', async () => {
        const watcher = createTestWatcher();
        const session = createMockSession({ id: 'session-1', agentId: null });
        const viewport = 'An error occurred in the terminal';
        const viewportHash = 'abc123def456';
        const triggerCount = 1;

        await service.triggerEvent(watcher, session, viewport, viewportHash, triggerCount);

        expect(mockEventsService.publish).toHaveBeenCalledWith(
          'terminal.watcher.triggered',
          expect.any(Object),
        );
      });

      it('should construct payload with all required fields', async () => {
        const watcher = createTestWatcher({
          id: 'watcher-123',
          name: 'My Watcher',
          eventName: 'custom.event',
          projectId: 'project-456',
          condition: { type: 'contains', pattern: 'error pattern' },
        });
        const session = createMockSession({ id: 'session-789', agentId: null });
        const viewport = 'test viewport content';
        const viewportHash = 'hash12345678';
        const triggerCount = 5;

        await service.triggerEvent(watcher, session, viewport, viewportHash, triggerCount);

        const publishCall = mockEventsService.publish.mock.calls[0];
        const payload = publishCall[1];

        expect(payload.watcherId).toBe('watcher-123');
        expect(payload.watcherName).toBe('My Watcher');
        expect(payload.customEventName).toBe('custom.event');
        expect(payload.sessionId).toBe('session-789');
        expect(payload.projectId).toBe('project-456');
        expect(payload.viewportHash).toBe('hash12345678');
        expect(payload.matchedPattern).toBe('error pattern');
        expect(payload.triggerCount).toBe(5);
        expect(payload.triggeredAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      });
    });

    describe('viewportSnippet', () => {
      it('should use last 500 chars of viewport', async () => {
        const watcher = createTestWatcher();
        const session = createMockSession();
        const longViewport = 'a'.repeat(600) + 'END';
        const viewportHash = 'hash123';
        const triggerCount = 1;

        await service.triggerEvent(watcher, session, longViewport, viewportHash, triggerCount);

        const payload = mockEventsService.publish.mock.calls[0][1];
        expect(payload.viewportSnippet).toHaveLength(500);
        expect(payload.viewportSnippet).toBe('a'.repeat(497) + 'END');
      });

      it('should use full viewport if less than 500 chars', async () => {
        const watcher = createTestWatcher();
        const session = createMockSession();
        const shortViewport = 'Short viewport content';
        const viewportHash = 'hash123';
        const triggerCount = 1;

        await service.triggerEvent(watcher, session, shortViewport, viewportHash, triggerCount);

        const payload = mockEventsService.publish.mock.calls[0][1];
        expect(payload.viewportSnippet).toBe('Short viewport content');
      });
    });

    describe('agent lookup', () => {
      it('should look up agent name when agentId is present', async () => {
        mockStorage.getAgent.mockResolvedValue({
          id: 'agent-1',
          name: 'Test Agent',
          profileId: 'profile-1',
        });

        const watcher = createTestWatcher();
        const session = createMockSession({ agentId: 'agent-1' });
        const viewport = 'error';
        const viewportHash = 'hash123';
        const triggerCount = 1;

        await service.triggerEvent(watcher, session, viewport, viewportHash, triggerCount);

        expect(mockStorage.getAgent).toHaveBeenCalledWith('agent-1');

        const payload = mockEventsService.publish.mock.calls[0][1];
        expect(payload.agentId).toBe('agent-1');
        expect(payload.agentName).toBe('Test Agent');
      });

      it('should set agentId and agentName to null when no agentId', async () => {
        const watcher = createTestWatcher();
        const session = createMockSession({ agentId: null });
        const viewport = 'error';
        const viewportHash = 'hash123';
        const triggerCount = 1;

        await service.triggerEvent(watcher, session, viewport, viewportHash, triggerCount);

        expect(mockStorage.getAgent).not.toHaveBeenCalled();

        const payload = mockEventsService.publish.mock.calls[0][1];
        expect(payload.agentId).toBeNull();
        expect(payload.agentName).toBeNull();
      });

      it('should set agentName to null when agent not found', async () => {
        mockStorage.getAgent.mockResolvedValue(null);

        const watcher = createTestWatcher();
        const session = createMockSession({ agentId: 'non-existent-agent' });
        const viewport = 'error';
        const viewportHash = 'hash123';
        const triggerCount = 1;

        await service.triggerEvent(watcher, session, viewport, viewportHash, triggerCount);

        const payload = mockEventsService.publish.mock.calls[0][1];
        expect(payload.agentId).toBe('non-existent-agent');
        expect(payload.agentName).toBeNull();
      });
    });

    describe('trigger count tracking', () => {
      it('should include correct trigger count in payload', async () => {
        const watcher = createTestWatcher();
        const session = createMockSession();
        const viewport = 'error';
        const viewportHash = 'hash123';

        await service.triggerEvent(watcher, session, viewport, viewportHash, 1);
        expect(mockEventsService.publish.mock.calls[0][1].triggerCount).toBe(1);

        await service.triggerEvent(watcher, session, viewport, viewportHash, 10);
        expect(mockEventsService.publish.mock.calls[1][1].triggerCount).toBe(10);
      });
    });
  });

  describe('testWatcher', () => {
    const createTestWatcher = (overrides: Partial<Watcher> = {}): Watcher => ({
      id: 'watcher-1',
      projectId: 'project-1',
      name: 'Test Watcher',
      description: null,
      enabled: true,
      scope: 'all',
      scopeFilterId: null,
      pollIntervalMs: 1000,
      viewportLines: 50,
      idleAfterSeconds: 0,
      condition: { type: 'contains', pattern: 'error' },
      cooldownMs: 5000,
      cooldownMode: 'time',
      eventName: 'test.event',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
      ...overrides,
    });

    it('should return results for matching sessions', async () => {
      const watcher = createTestWatcher();
      const sessions = [
        createMockSession({ id: 'session-1', tmuxSessionId: 'tmux-1', agentId: 'agent-1' }),
      ];
      mockSessionsService.listActiveSessions.mockResolvedValue(sessions);
      mockTmuxService.capturePane.mockResolvedValue('An error occurred');

      const results = await service.testWatcher(watcher);

      expect(results).toHaveLength(1);
      expect(results[0].sessionId).toBe('session-1');
      expect(results[0].agentId).toBe('agent-1');
      expect(results[0].tmuxSessionId).toBe('tmux-1');
      expect(results[0].viewport).toBe('An error occurred');
      expect(results[0].conditionMatched).toBe(true);
      expect(results[0].viewportHash).toHaveLength(16);
    });

    it('should handle sessions without tmuxSessionId', async () => {
      const watcher = createTestWatcher();
      const sessions = [createMockSession({ id: 'session-1', tmuxSessionId: null })];
      mockSessionsService.listActiveSessions.mockResolvedValue(sessions);

      const results = await service.testWatcher(watcher);

      expect(results).toHaveLength(1);
      expect(results[0].tmuxSessionId).toBeNull();
      expect(results[0].viewport).toBeNull();
      expect(results[0].conditionMatched).toBe(false);
    });

    it('should return empty array when no sessions match', async () => {
      const watcher = createTestWatcher({ scope: 'agent', scopeFilterId: 'non-existent' });
      mockSessionsService.listActiveSessions.mockResolvedValue([]);

      const results = await service.testWatcher(watcher);

      expect(results).toEqual([]);
    });

    it('should check condition without triggering events', async () => {
      const watcher = createTestWatcher();
      const sessions = [createMockSession({ tmuxSessionId: 'tmux-1' })];
      mockSessionsService.listActiveSessions.mockResolvedValue(sessions);
      mockTmuxService.capturePane.mockResolvedValue('error text');

      await service.testWatcher(watcher);

      // Should not publish any events
      expect(mockEventsService.publish).not.toHaveBeenCalled();
    });

    it('should handle capture errors gracefully', async () => {
      const watcher = createTestWatcher();
      const sessions = [createMockSession({ id: 'session-1', tmuxSessionId: 'tmux-1' })];
      mockSessionsService.listActiveSessions.mockResolvedValue(sessions);
      mockTmuxService.capturePane.mockRejectedValue(new Error('tmux error'));

      const results = await service.testWatcher(watcher);

      expect(results).toHaveLength(1);
      expect(results[0].viewport).toBeNull();
      expect(results[0].conditionMatched).toBe(false);
    });

    it('should test multiple sessions', async () => {
      const watcher = createTestWatcher();
      const sessions = [
        createMockSession({ id: 'session-1', tmuxSessionId: 'tmux-1' }),
        createMockSession({ id: 'session-2', tmuxSessionId: 'tmux-2' }),
      ];
      mockSessionsService.listActiveSessions.mockResolvedValue(sessions);
      mockTmuxService.capturePane
        .mockResolvedValueOnce('error here')
        .mockResolvedValueOnce('all good');

      const results = await service.testWatcher(watcher);

      expect(results).toHaveLength(2);
      expect(results[0].conditionMatched).toBe(true);
      expect(results[1].conditionMatched).toBe(false);
    });

    it('should short-circuit with idle gate info when session is busy', async () => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2024-01-01T00:10:00.000Z'));

      try {
        const watcher = createTestWatcher({
          idleAfterSeconds: 60,
          condition: { type: 'contains', pattern: 'error' },
        });
        const sessions = [
          createMockSession({
            id: 'session-1',
            tmuxSessionId: 'tmux-1',
            activityState: 'busy',
            lastActivityAt: '2024-01-01T00:09:55.000Z',
          }),
        ];
        mockSessionsService.listActiveSessions.mockResolvedValue(sessions);

        const results = await service.testWatcher(watcher);

        expect(results).toHaveLength(1);
        expect(results[0].viewport).toBe('[idle gate: session busy]');
        expect(results[0].viewportHash).toHaveLength(16);
        expect(results[0].conditionMatched).toBe(false);
        expect(mockTmuxService.capturePane).not.toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    });

    it('should continue with viewport capture when idle gate passes', async () => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2024-01-01T00:10:00.000Z'));

      try {
        const watcher = createTestWatcher({
          idleAfterSeconds: 60,
          condition: { type: 'contains', pattern: 'error' },
        });
        const sessions = [
          createMockSession({
            id: 'session-1',
            tmuxSessionId: 'tmux-1',
            activityState: 'idle',
            lastActivityAt: '2024-01-01T00:08:50.000Z',
          }),
        ];
        mockSessionsService.listActiveSessions.mockResolvedValue(sessions);
        mockTmuxService.capturePane.mockResolvedValue('An error occurred');

        const results = await service.testWatcher(watcher);

        expect(results).toHaveLength(1);
        expect(results[0].viewport).toBe('An error occurred');
        expect(results[0].conditionMatched).toBe(true);
        expect(results[0].viewportHash).toHaveLength(16);
        expect(mockTmuxService.capturePane).toHaveBeenCalledWith('tmux-1', 50, false);
      } finally {
        jest.useRealTimers();
      }
    });
  });

  // ============================================
  // LIFECYCLE TESTS
  // ============================================

  describe('onModuleInit', () => {
    it('should load all enabled watchers and start them', async () => {
      const watchers = [
        createMockWatcher({ id: 'watcher-1', pollIntervalMs: 1000 }),
        createMockWatcher({ id: 'watcher-2', pollIntervalMs: 2000 }),
      ];
      mockStorage.listEnabledWatchers.mockResolvedValue(watchers);

      await service.onModuleInit();

      expect(mockStorage.listEnabledWatchers).toHaveBeenCalled();
      expect(service.isWatcherRunning('watcher-1')).toBe(true);
      expect(service.isWatcherRunning('watcher-2')).toBe(true);
    });

    it('should handle empty enabled watchers list', async () => {
      mockStorage.listEnabledWatchers.mockResolvedValue([]);

      await service.onModuleInit();

      expect(mockStorage.listEnabledWatchers).toHaveBeenCalled();
      expect(service.getRunningWatcherIds()).toEqual([]);
    });

    it('should handle storage error gracefully', async () => {
      mockStorage.listEnabledWatchers.mockRejectedValue(new Error('Storage error'));

      // Should not throw
      await expect(service.onModuleInit()).resolves.not.toThrow();
    });
  });

  describe('onModuleDestroy', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should clear all polling intervals', async () => {
      const watcher = createMockWatcher({ id: 'watcher-1', pollIntervalMs: 1000 });
      await service.startWatcher(watcher);
      expect(service.isWatcherRunning('watcher-1')).toBe(true);

      await service.onModuleDestroy();

      expect(service.isWatcherRunning('watcher-1')).toBe(false);
      expect(service.getRunningWatcherIds()).toEqual([]);
    });

    it('should clear all state maps', async () => {
      const watcher = createMockWatcher({ id: 'watcher-1', pollIntervalMs: 1000 });
      await service.startWatcher(watcher);

      // Populate some state by running a check
      const session = createMockSession({ tmuxSessionId: 'tmux-1' });
      mockSessionsService.listActiveSessions.mockResolvedValue([session]);
      mockTmuxService.capturePane.mockResolvedValue('error found');

      // Trigger a poll cycle to populate state
      jest.advanceTimersByTime(1000);
      await Promise.resolve(); // flush promises

      await service.onModuleDestroy();

      // Verify all maps are cleared
      expect(service.getRunningWatcherIds()).toEqual([]);
    });
  });

  describe('startWatcher', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should create polling interval with correct interval', async () => {
      const watcher = createMockWatcher({ id: 'watcher-1', pollIntervalMs: 5000 });

      await service.startWatcher(watcher);

      expect(service.isWatcherRunning('watcher-1')).toBe(true);
    });

    it('should accept watcher ID and fetch from storage', async () => {
      const watcher = createMockWatcher({ id: 'watcher-1' });
      mockStorage.getWatcher.mockResolvedValue(watcher);

      await service.startWatcher('watcher-1');

      expect(mockStorage.getWatcher).toHaveBeenCalledWith('watcher-1');
      expect(service.isWatcherRunning('watcher-1')).toBe(true);
    });

    it('should not start if watcher ID not found', async () => {
      mockStorage.getWatcher.mockResolvedValue(null);

      await service.startWatcher('nonexistent');

      expect(service.isWatcherRunning('nonexistent')).toBe(false);
    });

    it('should stop existing watcher before restarting', async () => {
      const watcher1 = createMockWatcher({ id: 'watcher-1', pollIntervalMs: 1000 });
      const watcher2 = createMockWatcher({ id: 'watcher-1', pollIntervalMs: 2000 });

      await service.startWatcher(watcher1);
      expect(service.isWatcherRunning('watcher-1')).toBe(true);

      // Start again with different config
      await service.startWatcher(watcher2);
      expect(service.isWatcherRunning('watcher-1')).toBe(true);
    });

    it('should cache watcher config', async () => {
      const watcher = createMockWatcher({ id: 'watcher-1' });

      await service.startWatcher(watcher);

      // The config should be cached - verify by checking getWatcher isn't called during poll
      mockStorage.getWatcher.mockClear();
      mockSessionsService.listActiveSessions.mockResolvedValue([]);

      jest.advanceTimersByTime(watcher.pollIntervalMs);
      await Promise.resolve();

      expect(mockStorage.getWatcher).not.toHaveBeenCalled();
    });
  });

  describe('stopWatcher', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should clear polling interval', async () => {
      const watcher = createMockWatcher({ id: 'watcher-1', pollIntervalMs: 1000 });
      await service.startWatcher(watcher);
      expect(service.isWatcherRunning('watcher-1')).toBe(true);

      await service.stopWatcher('watcher-1');

      expect(service.isWatcherRunning('watcher-1')).toBe(false);
    });

    it('should clean up all prefix-matched state', async () => {
      const watcher = createMockWatcher({ id: 'watcher-1', pollIntervalMs: 1000 });
      await service.startWatcher(watcher);

      // Set up session and trigger some state
      const session = createMockSession({ id: 'session-1', tmuxSessionId: 'tmux-1' });
      mockSessionsService.listActiveSessions.mockResolvedValue([session]);
      mockTmuxService.capturePane.mockResolvedValue('error found');

      // Run a poll cycle to populate state
      jest.advanceTimersByTime(1000);
      await Promise.resolve();

      await service.stopWatcher('watcher-1');

      expect(service.isWatcherRunning('watcher-1')).toBe(false);
    });

    it('should handle stopping non-existent watcher gracefully', async () => {
      // Should not throw
      await expect(service.stopWatcher('nonexistent')).resolves.not.toThrow();
    });

    it('should remove watcher from config cache', async () => {
      const watcher = createMockWatcher({ id: 'watcher-1' });
      await service.startWatcher(watcher);
      await service.stopWatcher('watcher-1');

      // Start again with ID - should need to fetch from storage
      mockStorage.getWatcher.mockResolvedValue(watcher);
      await service.startWatcher('watcher-1');

      expect(mockStorage.getWatcher).toHaveBeenCalledWith('watcher-1');
    });
  });

  describe('isWatcherRunning', () => {
    it('should return true for running watcher', async () => {
      const watcher = createMockWatcher({ id: 'watcher-1' });
      await service.startWatcher(watcher);

      expect(service.isWatcherRunning('watcher-1')).toBe(true);
    });

    it('should return false for non-running watcher', () => {
      expect(service.isWatcherRunning('nonexistent')).toBe(false);
    });

    it('should return false after watcher is stopped', async () => {
      const watcher = createMockWatcher({ id: 'watcher-1' });
      await service.startWatcher(watcher);
      await service.stopWatcher('watcher-1');

      expect(service.isWatcherRunning('watcher-1')).toBe(false);
    });
  });

  describe('getRunningWatcherIds', () => {
    it('should return empty array when no watchers running', () => {
      expect(service.getRunningWatcherIds()).toEqual([]);
    });

    it('should return all running watcher IDs', async () => {
      const watcher1 = createMockWatcher({ id: 'watcher-1' });
      const watcher2 = createMockWatcher({ id: 'watcher-2' });

      await service.startWatcher(watcher1);
      await service.startWatcher(watcher2);

      const ids = service.getRunningWatcherIds();
      expect(ids).toContain('watcher-1');
      expect(ids).toContain('watcher-2');
      expect(ids).toHaveLength(2);
    });
  });
});

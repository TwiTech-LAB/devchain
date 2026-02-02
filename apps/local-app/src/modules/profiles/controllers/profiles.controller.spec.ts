import { Test, TestingModule } from '@nestjs/testing';
import { ProfilesController } from './profiles.controller';
import { STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { ValidationError, NotFoundError } from '../../../common/errors/error-types';
import { Agent, AgentProfile, ProfileProviderConfig } from '../../storage/models/domain.models';
import { AgentProfileWithPrompts } from '../dto';
jest.mock('../../../common/logging/logger', () => ({
  createLogger: () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() }),
}));

describe('ProfilesController', () => {
  let controller: ProfilesController;
  let storage: {
    createAgentProfile: jest.Mock;
    updateAgentProfile: jest.Mock;
    listAgentProfiles: jest.Mock;
    listAgentProfilesWithPrompts?: jest.Mock;
    getAgentProfile: jest.Mock;
    getAgentProfileWithPrompts?: jest.Mock;
    deleteAgentProfile: jest.Mock;
    setAgentProfilePrompts: jest.Mock;
    getPrompt: jest.Mock;
    getAgentProfilePrompts?: jest.Mock;
    // Provider config methods
    createProfileProviderConfig: jest.Mock;
    listProfileProviderConfigsByProfile: jest.Mock;
    reorderProfileProviderConfigs: jest.Mock;
    // Agent methods
    listAgents: jest.Mock;
  };

  const baseProfile: AgentProfile = {
    id: 'profile-1',
    projectId: 'project-1',
    name: 'Test Profile',
    familySlug: null,
    systemPrompt: null,
    instructions: null,
    temperature: null,
    maxTokens: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  };

  const baseProviderConfig: ProfileProviderConfig = {
    id: 'config-1',
    profileId: 'profile-1',
    providerId: 'provider-1',
    name: 'test-config',
    options: '--model test',
    env: { API_KEY: 'test-key' },
    position: 0,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  };

  const baseAgent: Agent = {
    id: 'agent-1',
    projectId: 'project-1',
    profileId: 'profile-1',
    providerConfigId: 'config-1',
    name: 'Test Agent',
    description: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  };

  beforeEach(async () => {
    storage = {
      createAgentProfile: jest.fn(),
      updateAgentProfile: jest.fn(),
      listAgentProfiles: jest.fn(),
      listAgentProfilesWithPrompts: jest.fn(),
      getAgentProfile: jest.fn(),
      getAgentProfileWithPrompts: jest.fn(),
      deleteAgentProfile: jest.fn(),
      setAgentProfilePrompts: jest.fn(),
      getPrompt: jest.fn(),
      // Provider config mocks
      createProfileProviderConfig: jest.fn(),
      listProfileProviderConfigsByProfile: jest.fn(),
      updateProfileProviderConfig: jest.fn(),
      reorderProfileProviderConfigs: jest.fn(),
      // Agent mocks
      listAgents: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ProfilesController],
      providers: [
        {
          provide: STORAGE_SERVICE,
          useValue: storage,
        },
      ],
    }).compile();

    controller = module.get(ProfilesController);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // Note: options field removed from CreateProfileSchema/UpdateProfileSchema in Phase 4
  // Provider configuration (including options) now lives in ProfileProviderConfig

  it('converts whitespace-only familySlug to null during create', async () => {
    const createdProfile: AgentProfile = { ...baseProfile, familySlug: null };
    storage.createAgentProfile.mockResolvedValue(createdProfile);

    await controller.createProfile({
      projectId: 'project-1',
      name: 'Test Profile',
      familySlug: '   ',
    });

    expect(storage.createAgentProfile).toHaveBeenCalledWith(
      expect.objectContaining({ familySlug: null }),
    );
  });

  it('trims and lowercases familySlug during create', async () => {
    const createdProfile: AgentProfile = { ...baseProfile, familySlug: 'my-family' };
    storage.createAgentProfile.mockResolvedValue(createdProfile);

    await controller.createProfile({
      projectId: 'project-1',
      name: 'Test Profile',
      familySlug: '  My-Family  ',
    });

    expect(storage.createAgentProfile).toHaveBeenCalledWith(
      expect.objectContaining({ familySlug: 'my-family' }),
    );
  });

  it('converts whitespace-only familySlug to null during update', async () => {
    const updatedProfile: AgentProfile = { ...baseProfile, familySlug: null };
    storage.updateAgentProfile.mockResolvedValue(updatedProfile);

    await controller.updateProfile('profile-1', { familySlug: '   ' });

    expect(storage.updateAgentProfile).toHaveBeenCalledWith('profile-1', { familySlug: null });
  });

  it('allows clearing familySlug by sending null during update', async () => {
    const updatedProfile: AgentProfile = { ...baseProfile, familySlug: null };
    storage.updateAgentProfile.mockResolvedValue(updatedProfile);

    await controller.updateProfile('profile-1', { familySlug: null });

    expect(storage.updateAgentProfile).toHaveBeenCalledWith('profile-1', { familySlug: null });
  });

  it('GET /api/profiles requires projectId and lists by project', async () => {
    storage.listAgentProfilesWithPrompts!.mockResolvedValue({
      items: [
        {
          ...baseProfile,
          prompts: [
            { promptId: 'p1', title: 'T p1', order: 1 },
            { promptId: 'p2', title: 'T p2', order: 2 },
          ],
        },
      ],
      total: 1,
      limit: 1,
      offset: 0,
    });

    const result = await controller.listProfiles('project-1');
    expect(storage.listAgentProfilesWithPrompts).toHaveBeenCalledWith({ projectId: 'project-1' });
    expect(result.items[0].id).toBe('profile-1');
    expect(result.items[0].prompts.map((p) => p.promptId)).toEqual(['p1', 'p2']);
    expect(result.items[0].prompts[0].order).toBe(1);
  });

  it('GET /api/profiles throws BadRequest when projectId is missing/empty', async () => {
    await expect(controller.listProfiles('')).rejects.toThrow(BadRequestException);
    // also undefined
    await expect(controller.listProfiles(undefined as unknown as string)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('PUT /api/profiles/:id rejects projectId change', async () => {
    storage.getAgentProfile.mockResolvedValue(baseProfile);
    await expect(
      controller.updateProfile('profile-1', { projectId: 'project-2' } as unknown as Parameters<
        typeof controller.updateProfile
      >[1]),
    ).rejects.toThrow(BadRequestException);
  });

  it('PUT /api/profiles/:id/prompts replaces assignments and returns ordered payload', async () => {
    storage.setAgentProfilePrompts.mockResolvedValue(undefined);
    storage.getAgentProfileWithPrompts!.mockResolvedValue({
      ...baseProfile,
      prompts: [
        { promptId: 'p1', title: 'Title p1', order: 1 },
        { promptId: 'p2', title: 'Title p2', order: 2 },
      ],
    } as unknown as Awaited<ReturnType<NonNullable<typeof storage.getAgentProfileWithPrompts>>>);

    const result = await controller.replaceProfilePrompts('profile-1', {
      promptIds: ['p1', 'p2', 'p1'],
    });

    expect(storage.setAgentProfilePrompts).toHaveBeenCalledWith('profile-1', ['p1', 'p2']);
    expect(result.profileId).toBe('profile-1');
    expect(result.prompts.map((p) => p.promptId)).toEqual(['p1', 'p2']);
    expect(result.prompts[0].order).toBe(1);
    expect(result.prompts[1].order).toBe(2);
  });

  it('GET /api/profiles/:id returns typed AgentProfileWithPrompts', async () => {
    const detailed: AgentProfileWithPrompts = {
      ...baseProfile,
      projectId: baseProfile.projectId ?? null,
      prompts: [
        { promptId: 'p1', title: 'T1', order: 1 },
        { promptId: 'p2', title: 'T2', order: 2 },
      ],
    };
    storage.getAgentProfileWithPrompts!.mockResolvedValue(detailed);
    const result = await controller.getProfile('profile-1');
    expect(result.id).toBe('profile-1');
    expect(result.prompts[0].title).toBe('T1');
    expect(result.prompts[0].order).toBe(1);
  });

  it('PUT /api/profiles/:id/prompts maps validation errors to BadRequest', async () => {
    storage.setAgentProfilePrompts.mockRejectedValue(new ValidationError('Cross-project'));
    await expect(
      controller.replaceProfilePrompts('profile-1', { promptIds: ['p1'] }),
    ).rejects.toThrow(BadRequestException);
  });

  // ============================================
  // PROFILE PROVIDER CONFIGS
  // ============================================

  describe('Provider Configs', () => {
    it('GET /api/profiles/:id/provider-configs lists configs for profile', async () => {
      storage.getAgentProfile.mockResolvedValue(baseProfile);
      storage.listProfileProviderConfigsByProfile.mockResolvedValue([baseProviderConfig]);

      const result = await controller.listProviderConfigs('profile-1');

      expect(storage.getAgentProfile).toHaveBeenCalledWith('profile-1');
      expect(storage.listProfileProviderConfigsByProfile).toHaveBeenCalledWith('profile-1');
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('config-1');
      expect(result[0].env).toEqual({ API_KEY: 'test-key' });
    });

    it('GET /api/profiles/:id/provider-configs returns empty array when no configs', async () => {
      storage.getAgentProfile.mockResolvedValue(baseProfile);
      storage.listProfileProviderConfigsByProfile.mockResolvedValue([]);

      const result = await controller.listProviderConfigs('profile-1');

      expect(result).toEqual([]);
    });

    it('GET /api/profiles/:id/provider-configs throws when profile not found', async () => {
      storage.getAgentProfile.mockRejectedValue(new NotFoundError('AgentProfile', 'profile-1'));

      await expect(controller.listProviderConfigs('profile-1')).rejects.toThrow(NotFoundError);
    });

    it('POST /api/profiles/:id/provider-configs creates config', async () => {
      storage.getAgentProfile.mockResolvedValue(baseProfile);
      storage.createProfileProviderConfig.mockResolvedValue(baseProviderConfig);

      const result = await controller.createProviderConfig('profile-1', {
        providerId: 'provider-1',
        name: 'test-config',
        options: '--model test',
        env: { API_KEY: 'test-key' },
      });

      expect(storage.createProfileProviderConfig).toHaveBeenCalledWith({
        profileId: 'profile-1',
        providerId: 'provider-1',
        name: 'test-config',
        options: '--model test',
        env: { API_KEY: 'test-key' },
      });
      expect(result.id).toBe('config-1');
    });

    it('POST /api/profiles/:id/provider-configs creates config with null env', async () => {
      const configWithNullEnv = { ...baseProviderConfig, env: null };
      storage.getAgentProfile.mockResolvedValue(baseProfile);
      storage.createProfileProviderConfig.mockResolvedValue(configWithNullEnv);

      const result = await controller.createProviderConfig('profile-1', {
        providerId: 'provider-1',
        name: 'simple-config',
      });

      expect(storage.createProfileProviderConfig).toHaveBeenCalledWith({
        profileId: 'profile-1',
        providerId: 'provider-1',
        name: 'simple-config',
        options: null,
        env: null,
      });
      expect(result.env).toBeNull();
    });

    it('POST /api/profiles/:id/provider-configs throws when profile not found', async () => {
      storage.getAgentProfile.mockRejectedValue(new NotFoundError('AgentProfile', 'profile-1'));

      await expect(
        controller.createProviderConfig('profile-1', { providerId: 'provider-1', name: 'test' }),
      ).rejects.toThrow(NotFoundError);
    });

    it('POST /api/profiles/:id/provider-configs validates env keys', async () => {
      storage.getAgentProfile.mockResolvedValue(baseProfile);

      await expect(
        controller.createProviderConfig('profile-1', {
          providerId: 'provider-1',
          name: 'bad-env-config',
          env: { 'INVALID-KEY': 'value' },
        }),
      ).rejects.toThrow();
    });

    it('POST /api/profiles/:id/provider-configs validates env values', async () => {
      storage.getAgentProfile.mockResolvedValue(baseProfile);

      await expect(
        controller.createProviderConfig('profile-1', {
          providerId: 'provider-1',
          name: 'bad-value-config',
          env: { KEY: 'has\nnewline' },
        }),
      ).rejects.toThrow();
    });

    describe('PUT /api/profiles/:id/provider-configs/order', () => {
      const configs = [
        { ...baseProviderConfig, id: '550e8400-e29b-41d4-a716-446655440000', position: 0 },
        { ...baseProviderConfig, id: '550e8400-e29b-41d4-a716-446655440001', position: 1 },
        { ...baseProviderConfig, id: '550e8400-e29b-41d4-a716-446655440002', position: 2 },
      ];

      beforeEach(() => {
        storage.getAgentProfile.mockResolvedValue(baseProfile);
        storage.listProfileProviderConfigsByProfile.mockResolvedValue(configs);
        storage.updateProfileProviderConfig.mockResolvedValue(baseProviderConfig);
        storage.reorderProfileProviderConfigs.mockResolvedValue(undefined);
      });

      it('reorders configs successfully', async () => {
        storage.reorderProfileProviderConfigs.mockResolvedValue(undefined);

        const result = await controller.reorderProviderConfigs('profile-1', {
          configIds: [
            '550e8400-e29b-41d4-a716-446655440002',
            '550e8400-e29b-41d4-a716-446655440000',
            '550e8400-e29b-41d4-a716-446655440001',
          ],
        });

        expect(result.success).toBe(true);
        expect(storage.reorderProfileProviderConfigs).toHaveBeenCalledWith('profile-1', [
          '550e8400-e29b-41d4-a716-446655440002',
          '550e8400-e29b-41d4-a716-446655440000',
          '550e8400-e29b-41d4-a716-446655440001',
        ]);
      });

      it('rejects empty configIds array', async () => {
        await expect(
          controller.reorderProviderConfigs('profile-1', { configIds: [] }),
        ).rejects.toThrow();
      });

      it('rejects configIds not belonging to profile', async () => {
        await expect(
          controller.reorderProviderConfigs('profile-1', {
            configIds: [
              '550e8400-e29b-41d4-a716-446655440000',
              '550e8400-e29b-41d4-a716-446655440099',
            ],
          }),
        ).rejects.toThrow();
      });

      it('rejects duplicate configIds', async () => {
        await expect(
          controller.reorderProviderConfigs('profile-1', {
            configIds: [
              '550e8400-e29b-41d4-a716-446655440000',
              '550e8400-e29b-41d4-a716-446655440000',
              '550e8400-e29b-41d4-a716-446655440001',
            ],
          }),
        ).rejects.toThrow();
      });

      it('rejects subset reorder (not all configs included)', async () => {
        await expect(
          controller.reorderProviderConfigs('profile-1', {
            configIds: [
              '550e8400-e29b-41d4-a716-446655440000',
              '550e8400-e29b-41d4-a716-446655440001',
            ],
          }),
        ).rejects.toThrow();
      });

      it('handles two-pass update correctly', async () => {
        storage.reorderProfileProviderConfigs.mockResolvedValue(undefined);

        const result = await controller.reorderProviderConfigs('profile-1', {
          configIds: [
            '550e8400-e29b-41d4-a716-446655440001',
            '550e8400-e29b-41d4-a716-446655440000',
            '550e8400-e29b-41d4-a716-446655440002',
          ],
        });

        expect(result.success).toBe(true);
        // Verify storage.reorderProviderConfigs was called with correct params
        expect(storage.reorderProfileProviderConfigs).toHaveBeenCalledWith('profile-1', [
          '550e8400-e29b-41d4-a716-446655440001',
          '550e8400-e29b-41d4-a716-446655440000',
          '550e8400-e29b-41d4-a716-446655440002',
        ]);
      });

      it('handles two-pass update correctly with high position values', async () => {
        // Mock configs with high position values (>= 1000)
        const highPositionConfigs = [
          { ...baseProviderConfig, id: '550e8400-e29b-41d4-a716-446655440000', position: 1500 },
          { ...baseProviderConfig, id: '550e8400-e29b-41d4-a716-446655440001', position: 1501 },
          { ...baseProviderConfig, id: '550e8400-e29b-41d4-a716-446655440002', position: 1502 },
        ];
        storage.listProfileProviderConfigsByProfile.mockResolvedValue(highPositionConfigs);
        storage.reorderProfileProviderConfigs.mockResolvedValue(undefined);

        const result = await controller.reorderProviderConfigs('profile-1', {
          configIds: [
            '550e8400-e29b-41d4-a716-446655440002',
            '550e8400-e29b-41d4-a716-446655440000',
            '550e8400-e29b-41d4-a716-446655440001',
          ],
        });

        expect(result.success).toBe(true);
        // Verify storage.reorderProviderConfigs was called
        expect(storage.reorderProfileProviderConfigs).toHaveBeenCalledWith('profile-1', [
          '550e8400-e29b-41d4-a716-446655440002',
          '550e8400-e29b-41d4-a716-446655440000',
          '550e8400-e29b-41d4-a716-446655440001',
        ]);
      });

      it('propagates errors from storage service (transaction rolls back)', async () => {
        storage.reorderProfileProviderConfigs.mockRejectedValue(
          new Error('Database connection lost'),
        );

        await expect(
          controller.reorderProviderConfigs('profile-1', {
            configIds: [
              '550e8400-e29b-41d4-a716-446655440000',
              '550e8400-e29b-41d4-a716-446655440001',
              '550e8400-e29b-41d4-a716-446655440002',
            ],
          }),
        ).rejects.toThrow('Database connection lost');
      });
    });
  });

  // ============================================
  // DELETE PROFILE
  // ============================================

  describe('Delete Profile', () => {
    it('DELETE /api/profiles/:id deletes profile when no agents use it', async () => {
      storage.getAgentProfile.mockResolvedValue(baseProfile);
      storage.listAgents.mockResolvedValue({ items: [], total: 0, limit: 10000, offset: 0 });
      storage.deleteAgentProfile.mockResolvedValue(undefined);

      await controller.deleteProfile('profile-1');

      expect(storage.getAgentProfile).toHaveBeenCalledWith('profile-1');
      expect(storage.listAgents).toHaveBeenCalledWith('project-1', { limit: 10000, offset: 0 });
      expect(storage.deleteAgentProfile).toHaveBeenCalledWith('profile-1');
    });

    it('DELETE /api/profiles/:id throws ConflictException when agents use profile', async () => {
      storage.getAgentProfile.mockResolvedValue(baseProfile);
      storage.listAgents.mockResolvedValue({
        items: [baseAgent, { ...baseAgent, id: 'agent-2', name: 'Another Agent' }],
        total: 2,
        limit: 10000,
        offset: 0,
      });

      await expect(controller.deleteProfile('profile-1')).rejects.toThrow(ConflictException);

      try {
        await controller.deleteProfile('profile-1');
      } catch (error) {
        expect(error).toBeInstanceOf(ConflictException);
        const response = (error as ConflictException).getResponse();
        expect(response).toMatchObject({
          message: 'Cannot delete profile: 2 agent(s) are still using it',
          agentCount: 2,
          agents: 'Test Agent, Another Agent',
        });
      }

      expect(storage.deleteAgentProfile).not.toHaveBeenCalled();
    });

    it('DELETE /api/profiles/:id includes all agent names in error message', async () => {
      storage.getAgentProfile.mockResolvedValue(baseProfile);
      storage.listAgents.mockResolvedValue({
        items: [
          { ...baseAgent, name: 'Agent A' },
          { ...baseAgent, id: 'agent-2', name: 'Agent B' },
          { ...baseAgent, id: 'agent-3', name: 'Agent C' },
        ],
        total: 3,
        limit: 10000,
        offset: 0,
      });

      try {
        await controller.deleteProfile('profile-1');
      } catch (error) {
        const response = (error as ConflictException).getResponse();
        expect(response).toMatchObject({
          agents: 'Agent A, Agent B, Agent C',
          agentCount: 3,
        });
      }
    });

    it('DELETE /api/profiles/:id allows deletion when other profiles agents exist', async () => {
      storage.getAgentProfile.mockResolvedValue(baseProfile);
      // Agent uses a different profile
      storage.listAgents.mockResolvedValue({
        items: [{ ...baseAgent, profileId: 'other-profile' }],
        total: 1,
        limit: 10000,
        offset: 0,
      });
      storage.deleteAgentProfile.mockResolvedValue(undefined);

      await controller.deleteProfile('profile-1');

      expect(storage.deleteAgentProfile).toHaveBeenCalledWith('profile-1');
    });

    it('DELETE /api/profiles/:id skips agent check for global profiles (no projectId)', async () => {
      const globalProfile = { ...baseProfile, projectId: null };
      storage.getAgentProfile.mockResolvedValue(globalProfile);
      storage.deleteAgentProfile.mockResolvedValue(undefined);

      await controller.deleteProfile('profile-1');

      expect(storage.listAgents).not.toHaveBeenCalled();
      expect(storage.deleteAgentProfile).toHaveBeenCalledWith('profile-1');
    });
  });
});

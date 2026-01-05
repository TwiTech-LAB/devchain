import { Test, TestingModule } from '@nestjs/testing';
import { ProfilesController } from './profiles.controller';
import { STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import { BadRequestException } from '@nestjs/common';
import { ValidationError } from '../../../common/errors/error-types';
import { AgentProfile } from '../../storage/models/domain.models';
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
  };

  const baseProfile: AgentProfile = {
    id: 'profile-1',
    projectId: 'project-1',
    name: 'Test Profile',
    providerId: 'provider-1',
    familySlug: null,
    options: '--model test',
    systemPrompt: null,
    instructions: null,
    temperature: null,
    maxTokens: null,
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

  it('allows clearing options by sending null during update', async () => {
    const updatedProfile: AgentProfile = { ...baseProfile, options: null };
    storage.updateAgentProfile.mockResolvedValue(updatedProfile);

    const result = await controller.updateProfile('profile-1', { options: null });

    expect(storage.updateAgentProfile).toHaveBeenCalledWith('profile-1', { options: null });
    expect(result.options).toBeNull();
  });

  it('converts whitespace-only options to null during update', async () => {
    const updatedProfile: AgentProfile = { ...baseProfile, options: null };
    storage.updateAgentProfile.mockResolvedValue(updatedProfile);

    await controller.updateProfile('profile-1', { options: '   ' });

    expect(storage.updateAgentProfile).toHaveBeenCalledWith('profile-1', { options: null });
  });

  it('trims surrounding whitespace for non-empty options when creating', async () => {
    const createdProfile: AgentProfile = { ...baseProfile, options: '--flag value' };
    storage.createAgentProfile.mockResolvedValue(createdProfile);

    const result = await controller.createProfile({
      projectId: 'project-1',
      name: 'Test Profile',
      providerId: 'provider-1',
      options: '  --flag value  ',
    });

    expect(storage.createAgentProfile).toHaveBeenCalledWith(
      expect.objectContaining({ options: '--flag value' }),
    );
    expect(result.options).toBe('--flag value');
  });

  it('converts whitespace-only familySlug to null during create', async () => {
    const createdProfile: AgentProfile = { ...baseProfile, familySlug: null };
    storage.createAgentProfile.mockResolvedValue(createdProfile);

    await controller.createProfile({
      projectId: 'project-1',
      name: 'Test Profile',
      providerId: 'provider-1',
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
      providerId: 'provider-1',
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
});

import { Test, TestingModule } from '@nestjs/testing';
import { ProviderProjectSyncService } from './provider-project-sync.service';
import { STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import { SettingsService } from '../../settings/services/settings.service';
import { UnifiedTemplateService } from '../../registry/services/unified-template.service';
import { NotFoundError } from '../../../common/errors/error-types';

function makeProvider(overrides?: Partial<{ id: string; name: string }>) {
  return { id: 'provider-1', name: 'Claude', ...overrides };
}

function makeProject(overrides?: Partial<{ id: string }>) {
  return { id: 'project-1', ...overrides };
}

function makeProfile(overrides?: Partial<{ id: string; name: string }>) {
  return { id: 'profile-1', name: 'Default Profile', ...overrides };
}

describe('ProviderProjectSyncService', () => {
  let service: ProviderProjectSyncService;
  let mockStorage: Record<string, jest.Mock>;
  let mockSettings: Record<string, jest.Mock>;
  let mockTemplateService: Record<string, jest.Mock>;

  beforeEach(async () => {
    mockStorage = {
      getProvider: jest.fn(),
      listProjects: jest.fn().mockResolvedValue({ items: [] }),
      listAgentProfiles: jest.fn().mockResolvedValue({ items: [] }),
      createIfMissing: jest.fn().mockResolvedValue({ inserted: true }),
    };

    mockSettings = {
      getProjectTemplateMetadata: jest.fn().mockReturnValue(null),
    };

    mockTemplateService = {
      getBundledTemplate: jest.fn(),
      getTemplate: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProviderProjectSyncService,
        { provide: STORAGE_SERVICE, useValue: mockStorage },
        { provide: SettingsService, useValue: mockSettings },
        { provide: UnifiedTemplateService, useValue: mockTemplateService },
      ],
    }).compile();

    service = module.get<ProviderProjectSyncService>(ProviderProjectSyncService);
  });

  describe('syncProviderToAllProjects', () => {
    it('throws NotFoundError when provider does not exist', async () => {
      mockStorage.getProvider.mockResolvedValue(null);

      await expect(service.syncProviderToAllProjects('no-such-id')).rejects.toThrow(NotFoundError);
    });

    it('returns empty result when no projects exist', async () => {
      mockStorage.getProvider.mockResolvedValue(makeProvider());
      mockStorage.listProjects.mockResolvedValue({ items: [] });

      const result = await service.syncProviderToAllProjects('provider-1');

      expect(result.providerId).toBe('provider-1');
      expect(result.insertedCount).toBe(0);
      expect(result.affectedProjectIds).toEqual([]);
      expect(result.warnings).toEqual([]);
    });

    it('returns empty result when projects have no profiles', async () => {
      mockStorage.getProvider.mockResolvedValue(makeProvider());
      mockStorage.listProjects.mockResolvedValue({ items: [makeProject()] });
      mockStorage.listAgentProfiles.mockResolvedValue({ items: [] });

      const result = await service.syncProviderToAllProjects('provider-1');

      expect(result.insertedCount).toBe(0);
    });

    describe('no template (null manifest)', () => {
      it('uses fallback candidate with provider name and adds no_template warning', async () => {
        mockStorage.getProvider.mockResolvedValue(makeProvider({ name: 'Claude' }));
        mockStorage.listProjects.mockResolvedValue({ items: [makeProject()] });
        mockStorage.listAgentProfiles.mockResolvedValue({ items: [makeProfile()] });
        mockSettings.getProjectTemplateMetadata.mockReturnValue(null);
        mockStorage.createIfMissing.mockResolvedValue({ inserted: true });

        const result = await service.syncProviderToAllProjects('provider-1');

        expect(result.insertedCount).toBe(1);
        expect(result.warnings).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ reason: 'no_template', projectId: 'project-1' }),
          ]),
        );
        expect(mockStorage.createIfMissing).toHaveBeenCalledWith(
          expect.objectContaining({
            profileId: 'profile-1',
            providerId: 'provider-1',
            name: 'Claude',
          }),
        );
      });
    });

    describe('template with matching providerConfigs', () => {
      beforeEach(() => {
        mockStorage.getProvider.mockResolvedValue(makeProvider({ name: 'Claude' }));
        mockStorage.listProjects.mockResolvedValue({ items: [makeProject()] });
        mockStorage.listAgentProfiles.mockResolvedValue({
          items: [makeProfile({ name: 'Default Profile' })],
        });

        mockSettings.getProjectTemplateMetadata.mockReturnValue({
          templateSlug: 'my-template',
          source: 'bundled',
          installedVersion: null,
          registryUrl: null,
          installedAt: '2024-01-01T00:00:00Z',
        });

        mockTemplateService.getBundledTemplate.mockReturnValue({
          content: {
            profiles: [
              {
                name: 'Default Profile',
                providerConfigs: [
                  {
                    name: 'Claude Config',
                    providerName: 'Claude',
                    options: '--model opus --effort high --dangerously-skip-permissions',
                    env: { API_KEY: 'test' },
                  },
                ],
              },
            ],
          },
          source: 'bundled',
        });
      });

      it('uses template-defined config name, options, and env', async () => {
        mockStorage.createIfMissing.mockResolvedValue({ inserted: true });

        const result = await service.syncProviderToAllProjects('provider-1');

        expect(result.insertedCount).toBe(1);
        expect(result.warnings.filter((w) => w.reason === 'no_template')).toHaveLength(0);
        expect(mockStorage.createIfMissing).toHaveBeenCalledWith(
          expect.objectContaining({
            name: 'Claude Config',
            options: '--model opus --effort high --dangerously-skip-permissions',
            env: { API_KEY: 'test' },
          }),
        );
      });

      it('case-insensitive profile name matching', async () => {
        mockStorage.listAgentProfiles.mockResolvedValue({
          items: [makeProfile({ name: '  default profile  ' })],
        });
        mockStorage.createIfMissing.mockResolvedValue({ inserted: true });

        const result = await service.syncProviderToAllProjects('provider-1');

        expect(result.insertedCount).toBe(1);
      });

      it('case-insensitive provider name matching', async () => {
        mockStorage.getProvider.mockResolvedValue(makeProvider({ name: '  CLAUDE  ' }));
        mockStorage.createIfMissing.mockResolvedValue({ inserted: true });

        const result = await service.syncProviderToAllProjects('provider-1');

        expect(result.insertedCount).toBe(1);
      });
    });

    describe('options passthrough', () => {
      beforeEach(() => {
        mockStorage.getProvider.mockResolvedValue(makeProvider({ name: 'Claude' }));
        mockStorage.listProjects.mockResolvedValue({ items: [makeProject()] });
        mockStorage.listAgentProfiles.mockResolvedValue({
          items: [makeProfile({ name: 'Default Profile' })],
        });
        mockSettings.getProjectTemplateMetadata.mockReturnValue({
          templateSlug: 'my-template',
          source: 'bundled',
          installedVersion: null,
          registryUrl: null,
          installedAt: '2024-01-01T00:00:00Z',
        });
        mockStorage.createIfMissing.mockResolvedValue({ inserted: true });
      });

      it('passes null options through unchanged when template has no options', async () => {
        mockTemplateService.getBundledTemplate.mockReturnValue({
          content: {
            profiles: [
              {
                name: 'Default Profile',
                providerConfigs: [
                  { name: 'Minimal', providerName: 'Claude', options: null, env: null },
                ],
              },
            ],
          },
          source: 'bundled',
        });

        await service.syncProviderToAllProjects('provider-1');

        expect(mockStorage.createIfMissing).toHaveBeenCalledWith(
          expect.objectContaining({ options: null }),
        );
      });

      it('preserves special characters in CLI options string', async () => {
        const cliOptions = '--instruction "You are helpful" --max-tokens 4096';
        mockTemplateService.getBundledTemplate.mockReturnValue({
          content: {
            profiles: [
              {
                name: 'Default Profile',
                providerConfigs: [
                  { name: 'Claude Config', providerName: 'Claude', options: cliOptions, env: null },
                ],
              },
            ],
          },
          source: 'bundled',
        });

        await service.syncProviderToAllProjects('provider-1');

        expect(mockStorage.createIfMissing).toHaveBeenCalledWith(
          expect.objectContaining({ options: cliOptions }),
        );
      });
    });

    describe('template with no matching providerConfigs', () => {
      it('falls back to provider name and adds no_manifest_match warning', async () => {
        mockStorage.getProvider.mockResolvedValue(makeProvider({ name: 'Gemini' }));
        mockStorage.listProjects.mockResolvedValue({ items: [makeProject()] });
        mockStorage.listAgentProfiles.mockResolvedValue({
          items: [makeProfile({ name: 'Default Profile' })],
        });

        mockSettings.getProjectTemplateMetadata.mockReturnValue({
          templateSlug: 'my-template',
          source: 'bundled',
          installedVersion: null,
          registryUrl: null,
          installedAt: '2024-01-01T00:00:00Z',
        });

        mockTemplateService.getBundledTemplate.mockReturnValue({
          content: {
            profiles: [
              {
                name: 'Default Profile',
                providerConfigs: [
                  { name: 'Claude Config', providerName: 'Claude', options: null, env: null },
                ],
              },
            ],
          },
          source: 'bundled',
        });

        mockStorage.createIfMissing.mockResolvedValue({ inserted: true });

        const result = await service.syncProviderToAllProjects('provider-1');

        expect(result.insertedCount).toBe(1);
        expect(result.warnings).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ reason: 'no_manifest_match', projectId: 'project-1' }),
          ]),
        );
        expect(mockStorage.createIfMissing).toHaveBeenCalledWith(
          expect.objectContaining({ name: 'Gemini' }),
        );
      });
    });

    describe('template with no matching profile name', () => {
      it('falls back to provider name and adds no_manifest_match warning', async () => {
        mockStorage.getProvider.mockResolvedValue(makeProvider({ name: 'Claude' }));
        mockStorage.listProjects.mockResolvedValue({ items: [makeProject()] });
        mockStorage.listAgentProfiles.mockResolvedValue({
          items: [makeProfile({ name: 'Custom Profile' })],
        });

        mockSettings.getProjectTemplateMetadata.mockReturnValue({
          templateSlug: 'my-template',
          source: 'bundled',
          installedVersion: null,
          registryUrl: null,
          installedAt: '2024-01-01T00:00:00Z',
        });

        mockTemplateService.getBundledTemplate.mockReturnValue({
          content: {
            profiles: [
              {
                name: 'Default Profile',
                providerConfigs: [
                  { name: 'Claude Config', providerName: 'Claude', options: null, env: null },
                ],
              },
            ],
          },
          source: 'bundled',
        });

        mockStorage.createIfMissing.mockResolvedValue({ inserted: true });

        const result = await service.syncProviderToAllProjects('provider-1');

        expect(result.warnings).toEqual(
          expect.arrayContaining([expect.objectContaining({ reason: 'no_manifest_match' })]),
        );
      });
    });

    describe('idempotent rerun', () => {
      it('increments skippedExistingCount on name_exists_same_provider', async () => {
        mockStorage.getProvider.mockResolvedValue(makeProvider());
        mockStorage.listProjects.mockResolvedValue({ items: [makeProject()] });
        mockStorage.listAgentProfiles.mockResolvedValue({ items: [makeProfile()] });
        mockStorage.createIfMissing.mockResolvedValue({
          inserted: false,
          reason: 'name_exists_same_provider',
        });

        const result = await service.syncProviderToAllProjects('provider-1');

        expect(result.insertedCount).toBe(0);
        expect(result.skippedExistingCount).toBe(1);
        expect(result.skippedConflictCount).toBe(0);
        expect(result.affectedProjectIds).toEqual([]);
      });
    });

    describe('conflict warnings', () => {
      it('adds warning for name_exists_other_provider conflict', async () => {
        mockStorage.getProvider.mockResolvedValue(makeProvider());
        mockStorage.listProjects.mockResolvedValue({ items: [makeProject()] });
        mockStorage.listAgentProfiles.mockResolvedValue({ items: [makeProfile()] });
        mockStorage.createIfMissing.mockResolvedValue({
          inserted: false,
          reason: 'name_exists_other_provider',
        });

        const result = await service.syncProviderToAllProjects('provider-1');

        expect(result.skippedConflictCount).toBe(1);
        expect(result.warnings).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              reason: 'name_taken_by_other_provider',
              projectId: 'project-1',
              profileId: 'profile-1',
            }),
          ]),
        );
      });

      it('adds warning for position_conflict', async () => {
        mockStorage.getProvider.mockResolvedValue(makeProvider());
        mockStorage.listProjects.mockResolvedValue({ items: [makeProject()] });
        mockStorage.listAgentProfiles.mockResolvedValue({ items: [makeProfile()] });
        mockStorage.createIfMissing.mockResolvedValue({
          inserted: false,
          reason: 'position_conflict',
        });

        const result = await service.syncProviderToAllProjects('provider-1');

        expect(result.skippedConflictCount).toBe(1);
        expect(result.warnings).toEqual(
          expect.arrayContaining([expect.objectContaining({ reason: 'position_conflict' })]),
        );
      });

      it('adds warning for unknown_constraint', async () => {
        mockStorage.getProvider.mockResolvedValue(makeProvider());
        mockStorage.listProjects.mockResolvedValue({ items: [makeProject()] });
        mockStorage.listAgentProfiles.mockResolvedValue({ items: [makeProfile()] });
        mockStorage.createIfMissing.mockResolvedValue({
          inserted: false,
          reason: 'unknown_constraint',
        });

        const result = await service.syncProviderToAllProjects('provider-1');

        expect(result.skippedConflictCount).toBe(1);
        expect(result.warnings).toEqual(
          expect.arrayContaining([expect.objectContaining({ reason: 'unknown_constraint' })]),
        );
      });
    });

    describe('multiple projects and profiles', () => {
      it('processes all projects and profiles, tracks affectedProjectIds correctly', async () => {
        mockStorage.getProvider.mockResolvedValue(makeProvider());
        mockStorage.listProjects.mockResolvedValue({
          items: [makeProject({ id: 'proj-a' }), makeProject({ id: 'proj-b' })],
        });
        mockStorage.listAgentProfiles
          .mockResolvedValueOnce({
            items: [makeProfile({ id: 'prof-a1' }), makeProfile({ id: 'prof-a2' })],
          })
          .mockResolvedValueOnce({
            items: [makeProfile({ id: 'prof-b1' })],
          });

        mockStorage.createIfMissing
          .mockResolvedValueOnce({ inserted: true })
          .mockResolvedValueOnce({ inserted: false, reason: 'name_exists_same_provider' })
          .mockResolvedValueOnce({ inserted: true });

        const result = await service.syncProviderToAllProjects('provider-1');

        expect(result.insertedCount).toBe(2);
        expect(result.skippedExistingCount).toBe(1);
        expect(result.affectedProjectIds).toEqual(['proj-a', 'proj-b']);
      });
    });

    describe('file-based template', () => {
      it('treats file-source template as no template', async () => {
        mockStorage.getProvider.mockResolvedValue(makeProvider());
        mockStorage.listProjects.mockResolvedValue({ items: [makeProject()] });
        mockStorage.listAgentProfiles.mockResolvedValue({ items: [makeProfile()] });
        mockSettings.getProjectTemplateMetadata.mockReturnValue({
          templateSlug: 'file-template',
          source: 'file',
          installedVersion: null,
          registryUrl: null,
          installedAt: '2024-01-01T00:00:00Z',
        });
        mockStorage.createIfMissing.mockResolvedValue({ inserted: true });

        const result = await service.syncProviderToAllProjects('provider-1');

        expect(result.warnings).toEqual(
          expect.arrayContaining([expect.objectContaining({ reason: 'no_template' })]),
        );
      });
    });

    describe('registry template', () => {
      it('resolves registry template profiles correctly', async () => {
        mockStorage.getProvider.mockResolvedValue(makeProvider({ name: 'Claude' }));
        mockStorage.listProjects.mockResolvedValue({ items: [makeProject()] });
        mockStorage.listAgentProfiles.mockResolvedValue({
          items: [makeProfile({ name: 'Default Profile' })],
        });

        mockSettings.getProjectTemplateMetadata.mockReturnValue({
          templateSlug: 'registry-template',
          source: 'registry',
          installedVersion: '1.0.0',
          registryUrl: 'https://example.com',
          installedAt: '2024-01-01T00:00:00Z',
        });

        mockTemplateService.getTemplate.mockResolvedValue({
          content: {
            profiles: [
              {
                name: 'Default Profile',
                providerConfigs: [
                  { name: 'Claude Config', providerName: 'Claude', options: null, env: null },
                ],
              },
            ],
          },
          source: 'registry',
        });

        mockStorage.createIfMissing.mockResolvedValue({ inserted: true });

        const result = await service.syncProviderToAllProjects('provider-1');

        expect(result.insertedCount).toBe(1);
        expect(mockStorage.createIfMissing).toHaveBeenCalledWith(
          expect.objectContaining({ name: 'Claude Config' }),
        );
      });

      it('falls back when registry template source mismatch', async () => {
        mockStorage.getProvider.mockResolvedValue(makeProvider());
        mockStorage.listProjects.mockResolvedValue({ items: [makeProject()] });
        mockStorage.listAgentProfiles.mockResolvedValue({ items: [makeProfile()] });

        mockSettings.getProjectTemplateMetadata.mockReturnValue({
          templateSlug: 'reg-template',
          source: 'registry',
          installedVersion: '1.0.0',
          registryUrl: 'https://example.com',
          installedAt: '2024-01-01T00:00:00Z',
        });

        mockTemplateService.getTemplate.mockResolvedValue({
          content: { profiles: [] },
          source: 'bundled',
        });

        mockStorage.createIfMissing.mockResolvedValue({ inserted: true });

        const result = await service.syncProviderToAllProjects('provider-1');

        expect(result.warnings).toEqual(
          expect.arrayContaining([expect.objectContaining({ reason: 'no_template' })]),
        );
      });
    });

    describe('template fetch error', () => {
      it('treats template fetch error as no template gracefully', async () => {
        mockStorage.getProvider.mockResolvedValue(makeProvider());
        mockStorage.listProjects.mockResolvedValue({ items: [makeProject()] });
        mockStorage.listAgentProfiles.mockResolvedValue({ items: [makeProfile()] });

        mockSettings.getProjectTemplateMetadata.mockReturnValue({
          templateSlug: 'bad-template',
          source: 'bundled',
          installedVersion: null,
          registryUrl: null,
          installedAt: '2024-01-01T00:00:00Z',
        });

        mockTemplateService.getBundledTemplate.mockImplementation(() => {
          throw new Error('Template not found');
        });

        mockStorage.createIfMissing.mockResolvedValue({ inserted: true });

        const result = await service.syncProviderToAllProjects('provider-1');

        expect(result.warnings).toEqual(
          expect.arrayContaining([expect.objectContaining({ reason: 'no_template' })]),
        );
        expect(result.insertedCount).toBe(1);
      });
    });

    describe('multiple template providerConfigs for same provider', () => {
      it('creates multiple configs when template defines them', async () => {
        mockStorage.getProvider.mockResolvedValue(makeProvider({ name: 'Claude' }));
        mockStorage.listProjects.mockResolvedValue({ items: [makeProject()] });
        mockStorage.listAgentProfiles.mockResolvedValue({
          items: [makeProfile({ name: 'Default Profile' })],
        });

        mockSettings.getProjectTemplateMetadata.mockReturnValue({
          templateSlug: 'my-template',
          source: 'bundled',
          installedVersion: null,
          registryUrl: null,
          installedAt: '2024-01-01T00:00:00Z',
        });

        mockTemplateService.getBundledTemplate.mockReturnValue({
          content: {
            profiles: [
              {
                name: 'Default Profile',
                providerConfigs: [
                  { name: 'Claude Opus', providerName: 'Claude', options: null, env: null },
                  { name: 'Claude Sonnet', providerName: 'Claude', options: null, env: null },
                  { name: 'Gemini Config', providerName: 'Gemini', options: null, env: null },
                ],
              },
            ],
          },
          source: 'bundled',
        });

        mockStorage.createIfMissing.mockResolvedValue({ inserted: true });

        const result = await service.syncProviderToAllProjects('provider-1');

        expect(result.insertedCount).toBe(2);
        expect(mockStorage.createIfMissing).toHaveBeenCalledTimes(2);
        expect(mockStorage.createIfMissing).toHaveBeenCalledWith(
          expect.objectContaining({ name: 'Claude Opus' }),
        );
        expect(mockStorage.createIfMissing).toHaveBeenCalledWith(
          expect.objectContaining({ name: 'Claude Sonnet' }),
        );
      });
    });
  });
});

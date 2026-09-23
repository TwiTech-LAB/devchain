import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { RegistryOrchestrationService } from './registry-orchestration.service';
import { RegistryClientService } from './registry-client.service';
import { TemplateCacheService } from './template-cache.service';
import { SettingsService } from '../../settings/services/settings.service';

describe('RegistryOrchestrationService download composition', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'registry-orchestration-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('returns the persisted entry after a miss completes its cache save', async () => {
    const slug = 'integration-template';
    const version = '1.0.0';
    const content = {
      prompts: [{ title: 'Persisted template' }],
      profiles: [],
    };
    const registryClient = {
      downloadTemplate: jest.fn().mockResolvedValue({
        content,
        checksum: 'download-checksum',
        slug,
        version,
      }),
    } as unknown as RegistryClientService;
    const settingsService = {
      getRegistryConfig: jest.fn().mockReturnValue({
        url: 'http://registry.test',
        cacheDir: tempDir,
      }),
    } as unknown as SettingsService;
    const cacheService = new TemplateCacheService(settingsService);
    await cacheService.onModuleInit();
    const orchestrationService = new RegistryOrchestrationService(
      registryClient,
      cacheService,
      settingsService,
    );

    const returned = await orchestrationService.getOrDownloadTemplate(slug, version);
    const persisted = await cacheService.getTemplate(slug, version);

    expect(registryClient.downloadTemplate).toHaveBeenCalledTimes(1);
    expect(returned).toEqual(persisted);
    expect(returned).toEqual({
      content,
      metadata: expect.objectContaining({
        slug,
        version,
        checksum: 'download-checksum',
      }),
    });
  });
});

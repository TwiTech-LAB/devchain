import { MODULE_METADATA } from '@nestjs/common/constants';
import { AnthropicSkillSource } from './adapters/anthropic-skill-source.adapter';
import type { SkillSourceAdapter } from './adapters/skill-source.adapter';
import { GitHubDirectorySkillSourceAdapter } from './adapters/github-directory-skill-source.adapter';
import { MicrosoftSkillSource } from './adapters/microsoft-skill-source.adapter';
import { OpenAISkillSource } from './adapters/openai-skill-source.adapter';
import { SkillsModule } from './skills.module';
import { SKILL_SOURCE_ADAPTERS } from './adapters/skill-source.adapter';
import { TrailOfBitsSkillSource } from './adapters/trailofbits-skill-source.adapter';
import { VercelSkillSource } from './adapters/vercel-skill-source.adapter';
import { SkillSourceLifecycleService } from './services/skill-source-lifecycle.service';
import { SkillSyncService } from './services/skill-sync.service';

type FactoryProvider = {
  provide: unknown;
  useFactory: (...args: unknown[]) => unknown;
  inject?: unknown[];
};

function providers(): FactoryProvider[] {
  return ((Reflect.getMetadata(MODULE_METADATA.PROVIDERS, SkillsModule) as unknown[]) ?? []).filter(
    (provider): provider is FactoryProvider =>
      typeof provider === 'object' && provider !== null && 'provide' in provider,
  );
}

describe('SkillsModule', () => {
  it('registers one lifecycle owner, exports it for the MCP registry, and keeps the sync executor private', () => {
    const moduleProviders =
      (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, SkillsModule) as unknown[]) ?? [];
    const moduleExports =
      (Reflect.getMetadata(MODULE_METADATA.EXPORTS, SkillsModule) as unknown[]) ?? [];

    expect(
      moduleProviders.filter((provider) => provider === SkillSourceLifecycleService),
    ).toHaveLength(1);
    expect(moduleProviders).toContain(SkillSyncService);
    expect(moduleExports).not.toContain(SkillSyncService);
    expect(moduleExports).toContain(SkillSourceLifecycleService);
  });

  it('registers exactly one configured native devchain adapter in the built-in list', () => {
    const moduleProviders = providers();
    const configuredProvider = moduleProviders.find(
      (provider) => provider.provide === GitHubDirectorySkillSourceAdapter,
    );
    const adapterListProvider = moduleProviders.find(
      (provider) => provider.provide === SKILL_SOURCE_ADAPTERS,
    );

    expect(configuredProvider).toBeDefined();
    expect(adapterListProvider).toBeDefined();

    const devchainAdapter = configuredProvider?.useFactory() as GitHubDirectorySkillSourceAdapter;
    expect(devchainAdapter).toBeInstanceOf(GitHubDirectorySkillSourceAdapter);
    expect(devchainAdapter.sourceName).toBe('devchain');
    expect(devchainAdapter.repoUrl).toBe(
      'https://github.com/TwiTech-LAB/devchain/tree/main/apps/local-app/skills',
    );
    expect(devchainAdapter.skillsRoot).toBe('apps/local-app/skills');

    const createBuiltIns = adapterListProvider?.useFactory as (
      ...adapters: SkillSourceAdapter[]
    ) => SkillSourceAdapter[];
    const builtIns = createBuiltIns(
      new AnthropicSkillSource(),
      new MicrosoftSkillSource(),
      new OpenAISkillSource(),
      new TrailOfBitsSkillSource(),
      new VercelSkillSource(),
      devchainAdapter,
    );

    expect(builtIns.map((adapter) => adapter.sourceName)).toEqual([
      'anthropic',
      'microsoft',
      'openai',
      'trailofbits',
      'vercel',
      'devchain',
    ]);
    expect(builtIns.filter((adapter) => adapter.sourceName === 'devchain')).toHaveLength(1);
    expect(adapterListProvider?.inject).toEqual([
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      GitHubDirectorySkillSourceAdapter,
    ]);
  });
});

import { Test } from '@nestjs/testing';
import { ProviderAdaptersModule } from './provider-adapters.module';
import { ProviderAdapterFactory } from './provider-adapter.factory';

describe('ProviderAdaptersModule', () => {
  it('compiles and resolves ProviderAdapterFactory without DI errors', async () => {
    const module = await Test.createTestingModule({
      imports: [ProviderAdaptersModule],
    }).compile();

    const factory = module.get(ProviderAdapterFactory);
    expect(factory).toBeDefined();
    expect(factory.getAdapter('claude')).toBeDefined();
    expect(factory.getAdapter('copilot')).toBeDefined();
    expect(typeof factory.getPostPasteDelayMsForAgent).toBe('function');

    await module.close();
  });
});

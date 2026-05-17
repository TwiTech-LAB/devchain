import { Test } from '@nestjs/testing';
import { ProviderAdaptersModule } from '../../../providers/adapters/provider-adapters.module';
import { ConfigFileMcpRegistrationAdapter } from './config-file-mcp-registration.adapter';

jest.mock('../../../../common/logging/logger', () => {
  const instance = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { createLogger: () => instance };
});

describe('ConfigFileMcpRegistrationAdapter — module wiring', () => {
  it('resolves when McpModule imports ProviderAdaptersModule and registers ConfigFileMcpRegistrationAdapter', async () => {
    const module = await Test.createTestingModule({
      imports: [ProviderAdaptersModule],
      providers: [ConfigFileMcpRegistrationAdapter],
    }).compile();

    const adapter = module.get(ConfigFileMcpRegistrationAdapter);
    expect(adapter).toBeDefined();
    expect(typeof adapter.register).toBe('function');

    await module.close();
  });
});

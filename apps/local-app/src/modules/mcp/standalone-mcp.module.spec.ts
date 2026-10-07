import { Test, TestingModule } from '@nestjs/testing';
import { StandaloneMcpModule } from './standalone-mcp.module';
import { McpService } from './services/mcp.service';
import { PtyService } from '../terminal/services/pty.service';
import { DB_CONNECTION } from '../storage/db/db.provider';
import { STORAGE_SERVICE } from '../storage/interfaces/storage.interface';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { McpToolBindingRegistry } from './services/mcp-tool-binding.registry';

describe('StandaloneMcpModule', () => {
  let module: TestingModule;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [StandaloneMcpModule],
    })
      .overrideProvider(DB_CONNECTION)
      .useValue({})
      .overrideProvider(STORAGE_SERVICE)
      .useValue({
        listProviders: () => ({ items: [] }),
      })
      .compile();
  });

  afterAll(async () => {
    await module?.close();
  });

  it('keeps only StorageModule in the standalone import graph', () => {
    const imports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, StandaloneMcpModule) ??
      []) as Array<{ name?: string }>;

    expect(imports.map((importedModule) => importedModule.name)).toEqual(['StorageModule']);
  });

  it('provides the binding registry privately', () => {
    const providers = (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, StandaloneMcpModule) ??
      []) as unknown[];
    const exports = (Reflect.getMetadata(MODULE_METADATA.EXPORTS, StandaloneMcpModule) ??
      []) as unknown[];

    expect(providers).toContain(McpToolBindingRegistry);
    expect(exports).not.toContain(McpToolBindingRegistry);
  });

  it('does NOT include TerminalModule in graph (PtyService not resolvable)', () => {
    expect(() => module.get(PtyService)).toThrow();
  });

  it('preserves SERVICE_UNAVAILABLE response for tools with absent full-app deps', async () => {
    const service = module.get(McpService);
    const response = await service.handleToolCall('devchain_send_message', {
      sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      recipientAgentNames: ['test-agent'],
      message: 'hello',
    });
    expect(response.success).toBe(false);
    expect(response.error?.code).toBe('SERVICE_UNAVAILABLE');
  });
});

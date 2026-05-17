import { Test, TestingModule } from '@nestjs/testing';
import { StandaloneMcpModule } from './standalone-mcp.module';
import { McpService } from './services/mcp.service';
import { REALTIME_BROADCASTER } from '../realtime/ports/realtime-broadcaster.port';
import { PtyService } from '../terminal/services/pty.service';
import { DB_CONNECTION } from '../storage/db/db.provider';
import { STORAGE_SERVICE } from '../storage/interfaces/storage.interface';

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
        getFeatureFlags: () => ({}),
        listProviders: () => ({ items: [] }),
      })
      .compile();
  });

  afterAll(async () => {
    await module?.close();
  });

  it('instantiates McpService', () => {
    const service = module.get(McpService);
    expect(service).toBeDefined();
  });

  it('does NOT include TerminalModule in graph (PtyService not resolvable)', () => {
    expect(() => module.get(PtyService)).toThrow();
  });

  it('provides REALTIME_BROADCASTER as no-op', () => {
    const broadcaster = module.get(REALTIME_BROADCASTER);
    expect(broadcaster).toBeDefined();
    expect(broadcaster.broadcastEvent('test', 'event', {})).toBeUndefined();
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

import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { STORAGE_SERVICE, type StorageService } from '../storage/interfaces/storage.interface';
import { McpHttpController } from './controllers/mcp-http.controller';
import { McpSdkController } from './controllers/mcp-sdk.controller';
import { McpService } from './services/mcp.service';
import { McpServerService } from './services/mcp-server.service';
import { McpToolBindingRegistry } from './services/mcp-tool-binding.registry';
import { createMcpToolBindingRegistryFixture } from './services/testing/mcp-tool-binding-registry.fixture';
import { worktreeMetadata } from './tool-descriptors/worktree.metadata';

// Fastify injection exercises both real protocol adapters without a database or live Git.
describe('MCP worktree tool transport contracts', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const storage = {} as StorageService;
    const module = await Test.createTestingModule({
      controllers: [McpHttpController, McpSdkController],
      providers: [
        McpService,
        McpServerService,
        { provide: STORAGE_SERVICE, useValue: storage },
        {
          provide: McpToolBindingRegistry,
          useFactory: () => createMcpToolBindingRegistryFixture(storage),
        },
      ],
    }).compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app?.close();
  });

  it.each(['/mcp/rpc', '/mcp'])('advertises all five worktree tools through %s', async (url) => {
    const response = await app.inject({
      method: 'POST',
      url,
      headers: { accept: 'application/json, text/event-stream' },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });
    expect(response.statusCode).toBe(200);
    const data = response.body.startsWith('{')
      ? response.body
      : response.body
          .split('\n')
          .find((line) => line.startsWith('data: '))
          ?.slice(6);
    const body = JSON.parse(data ?? '') as {
      result: { tools: Array<{ name: string; inputSchema: unknown }> };
    };
    const tools = body.result.tools.filter((tool) => tool.name.startsWith('devchain_worktrees_'));
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      worktreeMetadata.map((tool) => tool.name).sort(),
    );
    for (const tool of tools)
      expect(tool.inputSchema).toMatchObject({ additionalProperties: false });
  });
});

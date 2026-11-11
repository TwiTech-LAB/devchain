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

describe('MCP tool result layout through /mcp', () => {
  let app: NestFastifyApplication;
  const sop = `# SOP\n${'Step text. '.repeat(300)}\n## Last section\nQuote me.`;

  beforeAll(async () => {
    const registry = {
      resolve: () => ({
        paramsSchema: null,
        invoke: async () => ({
          success: true,
          data: { agent: { name: 'Coder', profile: { instructionsResolved: { contentMd: sop } } } },
        }),
      }),
    };
    const module = await Test.createTestingModule({
      controllers: [McpSdkController],
      providers: [
        McpService,
        McpServerService,
        { provide: STORAGE_SERVICE, useValue: {} },
        { provide: McpToolBindingRegistry, useValue: registry },
      ],
    }).compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('returns a long field as a section with real line breaks', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { accept: 'application/json, text/event-stream' },
      payload: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'devchain_get_agent_by_name', arguments: {} },
      },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as {
      result: { content: Array<{ type: string; text: string }> };
    };
    const path = 'agent.profile.instructionsResolved.contentMd';

    expect(body.result.content).toHaveLength(1);
    expect(body.result.content[0].text).toBe(
      [
        JSON.stringify(
          {
            agent: {
              name: 'Coder',
              profile: {
                instructionsResolved: {
                  contentMd: `[moved: full text in section «${path}» below]`,
                },
              },
            },
          },
          null,
          2,
        ),
        `===== ${path} =====`,
        sop,
        `===== end ${path} =====`,
      ].join('\n'),
    );
  });
});

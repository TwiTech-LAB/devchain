import type { ProjectCommunicationService } from '../../project-communication/project-communication.service';
import type { StorageService } from '../../storage/interfaces/storage.interface';
import { filterHiddenTools, RECORDS_TOOL_NAMES } from '../constants';
import { allMetadata } from '../tool-descriptors';
import type { McpBindingRuntime } from '../tool-descriptors/binding-types';
import { projectBindings } from '../tool-descriptors/project.bindings';
import { allBindingDefinitions, allBindingGroups } from '../tool-descriptors/runtime-bindings';
import { skillBindings } from '../tool-descriptors/skill.bindings';
import * as nullAdapter from './handlers/null-adapter';
import { createMcpToolBindingRegistryFixture } from './testing/mcp-tool-binding-registry.fixture';
import { McpService } from './mcp.service';

const SESSION_ID = '00000000-0000-0000-0000-000000000001';
const PROJECT_ID = '00000000-0000-0000-0000-000000000002';
const AGENT_ID = '00000000-0000-0000-0000-000000000003';

function createStorage(): StorageService {
  return {
    getAgent: jest.fn().mockResolvedValue({
      id: AGENT_ID,
      name: 'Coder',
      projectId: PROJECT_ID,
    }),
    getProject: jest.fn().mockResolvedValue({
      id: PROJECT_ID,
      name: 'Project',
      rootPath: '/project',
    }),
  } as unknown as StorageService;
}

function createSessionsService(): NonNullable<McpBindingRuntime['sessionsService']> {
  return {
    listActiveSessions: jest.fn().mockResolvedValue([
      {
        id: SESSION_ID,
        agentId: AGENT_ID,
        status: 'running',
        startedAt: '2024-01-01T00:00:00Z',
      },
    ]),
  } as unknown as NonNullable<McpBindingRuntime['sessionsService']>;
}

function minimalRuntime(overrides: Partial<McpBindingRuntime> = {}): McpBindingRuntime {
  return {
    storage: createStorage(),
    instructionsResolver: { resolve: jest.fn() } as McpBindingRuntime['instructionsResolver'],
    defaultInlineMaxBytes: 64 * 1024,
    resolveSessionContext: jest.fn().mockResolvedValue({
      success: true,
      data: {
        type: 'agent',
        session: { id: SESSION_ID, agentId: AGENT_ID, status: 'running', startedAt: '' },
        agent: { id: AGENT_ID, name: 'Coder', projectId: PROJECT_ID },
        project: { id: PROJECT_ID, name: 'Project', rootPath: '/project' },
      },
    }),
    ...overrides,
  };
}

describe('McpToolBindingRegistry composition', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('publishes ten groups and forty-four unique executable names with exact metadata parity', () => {
    const names = allBindingDefinitions.map((definition) => definition.name);

    expect(allBindingGroups).toHaveLength(10);
    expect(names).toHaveLength(44);
    expect(new Set(names).size).toBe(44);
    expect(new Set(names)).toEqual(new Set(allMetadata.map((metadata) => metadata.name)));
  });

  it('resolves every executable binding with its metadata schema', () => {
    const registry = createMcpToolBindingRegistryFixture(createStorage());

    for (const metadata of allMetadata) {
      const resolved = registry.resolve(metadata.name);
      expect(resolved).toBeDefined();
      expect(resolved?.paramsSchema).toBe(metadata.paramsSchema);
    }
  });

  it('fails fast on duplicate metadata names', () => {
    const duplicate = allMetadata[0];
    allMetadata.push(duplicate);
    try {
      expect(() => createMcpToolBindingRegistryFixture(createStorage())).toThrow(
        `Duplicate MCP metadata name: ${duplicate.name}`,
      );
    } finally {
      allMetadata.pop();
    }
  });

  it('fails fast when metadata has no executable binding', () => {
    allMetadata.push({
      name: 'devchain_orphan_metadata',
      description: 'test-only orphan',
      inputSchema: { type: 'object', properties: {} },
      paramsSchema: null,
    });
    try {
      expect(() => createMcpToolBindingRegistryFixture(createStorage())).toThrow(
        /metadataWithoutBindings=devchain_orphan_metadata/,
      );
    } finally {
      allMetadata.pop();
    }
  });

  it('fails fast when an executable binding has no metadata', () => {
    const removed = allMetadata.shift();
    try {
      expect(() => createMcpToolBindingRegistryFixture(createStorage())).toThrow(
        new RegExp(`bindingsWithoutMetadata=${removed?.name}`),
      );
    } finally {
      if (removed) allMetadata.unshift(removed);
    }
  });

  it('binds fresh closures to independent runtimes', async () => {
    const firstTargets = { items: [{ id: 'first' }], total: 1, limit: 50, offset: 0 };
    const secondTargets = { items: [{ id: 'second' }], total: 1, limit: 50, offset: 0 };
    const firstService = {
      listTargets: jest.fn().mockResolvedValue({ result: firstTargets }),
    } as unknown as ProjectCommunicationService;
    const secondService = {
      listTargets: jest.fn().mockResolvedValue({ result: secondTargets }),
    } as unknown as ProjectCommunicationService;
    const first = projectBindings[0].bind(
      minimalRuntime({ projectCommunicationService: firstService }),
    );
    const second = projectBindings[0].bind(
      minimalRuntime({ projectCommunicationService: secondService }),
    );

    expect(first).not.toBe(second);
    await expect(first({ sessionId: SESSION_ID, limit: 50, offset: 0 })).resolves.toEqual({
      success: true,
      data: firstTargets,
    });
    await expect(second({ sessionId: SESSION_ID, limit: 50, offset: 0 })).resolves.toEqual({
      success: true,
      data: secondTargets,
    });
  });

  it('constructs null adapters lazily when a bound tool is invoked', async () => {
    const createAdapter = jest.spyOn(nullAdapter, 'createNullAdapter');
    const invoke = skillBindings[0].bind(minimalRuntime());

    expect(createAdapter).not.toHaveBeenCalled();
    await invoke({ sessionId: SESSION_ID });
    expect(createAdapter).toHaveBeenCalledWith('SkillsService');
  });

  it('validates through a real service before constructing the domain context', async () => {
    const createAdapter = jest.spyOn(nullAdapter, 'createNullAdapter');
    const storage = createStorage();
    const service = new McpService(storage, createMcpToolBindingRegistryFixture(storage));

    const result = await service.handleToolCall('devchain_list_skills', {});

    expect(result.error?.code).toBe('VALIDATION_ERROR');
    expect(createAdapter).not.toHaveBeenCalled();
  });

  it('returns UNKNOWN_TOOL for removed document tool names through the real registry', async () => {
    const storage = createStorage();
    const registry = createMcpToolBindingRegistryFixture(storage, {
      sessionsService: createSessionsService(),
    });
    const service = new McpService(storage, registry);

    const metadataNames = allMetadata.map(({ name }) => name);
    expect(metadataNames).not.toContain('devchain_list_documents');
    expect(metadataNames).not.toContain('devchain_get_document');
    expect(metadataNames).not.toContain('devchain_create_document');
    expect(metadataNames).not.toContain('devchain_update_document');
    expect(filterHiddenTools(allMetadata).map(({ name }) => name)).toEqual(
      metadataNames.filter((name) => !RECORDS_TOOL_NAMES.includes(name)),
    );

    for (const name of [
      'devchain_list_documents',
      'devchain_get_document',
      'devchain_create_document',
      'devchain_update_document',
    ]) {
      await expect(service.handleToolCall(name, { sessionId: SESSION_ID })).resolves.toMatchObject({
        success: false,
        error: { code: 'UNKNOWN_TOOL' },
      });
    }
  });
});

import { z } from 'zod';
import type { StorageService } from '../../storage/interfaces/storage.interface';
import { UpdateEpicParamsSchema } from '../dtos/mcp.dto';
import type { McpToolBindingRegistry, ResolvedMcpToolBinding } from './mcp-tool-binding.registry';
import { McpService } from './mcp.service';
import { ResourceResolver } from './utils/resource-resolver';

describe('McpService interface', () => {
  let resolve: jest.Mock<ResolvedMcpToolBinding | undefined, [string]>;
  let service: McpService;

  beforeEach(() => {
    resolve = jest.fn();
    service = new McpService(
      {} as StorageService,
      { resolve } as unknown as McpToolBindingRegistry,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each([
    ['devchain.get.prompt', 'devchain_get_prompt'],
    ['devchain/get/prompt', 'devchain_get_prompt'],
    ['devchain-get-prompt', 'devchain_get_prompt'],
  ])('normalizes %s before registry lookup', async (input, normalized) => {
    resolve.mockReturnValue(undefined);

    await service.handleToolCall(input, {});

    expect(resolve).toHaveBeenCalledWith(normalized);
  });

  it.each([null, undefined])('normalizes %s parameters to an empty object', async (params) => {
    const invoke = jest.fn().mockResolvedValue({ success: true });
    resolve.mockReturnValue({ paramsSchema: null, invoke });

    await service.handleToolCall('devchain_test', params);

    expect(invoke).toHaveBeenCalledWith({});
  });

  it('acknowledges initialization without consulting the registry', async () => {
    await expect(service.handleToolCall('notifications/initialized', undefined)).resolves.toEqual({
      success: true,
      data: { acknowledged: true },
    });
    expect(resolve).not.toHaveBeenCalled();
  });

  it('returns the stable unknown-tool response with the original name', async () => {
    resolve.mockReturnValue(undefined);

    await expect(service.handleToolCall('retired.tool', {})).resolves.toEqual({
      success: false,
      error: { code: 'UNKNOWN_TOOL', message: 'Unknown tool: retired.tool' },
    });
  });

  it('performs central Zod parsing and forwards parsed output', async () => {
    const invoke = jest.fn().mockResolvedValue({ success: true });
    resolve.mockReturnValue({
      paramsSchema: z.object({ count: z.coerce.number(), label: z.string().default('ready') }),
      invoke,
    });

    await service.handleToolCall('devchain_test', { count: '3' });

    expect(invoke).toHaveBeenCalledWith({ count: 3, label: 'ready' });
  });

  it('includes a nested-parameter suggestion in validation errors', async () => {
    resolve.mockReturnValue({ paramsSchema: UpdateEpicParamsSchema, invoke: jest.fn() });

    const response = await service.handleToolCall('devchain_update_epic', {
      sessionId: '12345678',
      id: '00000000-0000-0000-0000-000000000001',
      version: 1,
      agentName: 'Epic Manager',
    });

    expect(response.error?.code).toBe('VALIDATION_ERROR');
    expect(response.error?.data).toMatchObject({
      suggestions: ['Did you mean: assignment.agentName?'],
    });
  });

  it('omits suggestions for unrelated unknown parameters', async () => {
    resolve.mockReturnValue({ paramsSchema: UpdateEpicParamsSchema, invoke: jest.fn() });

    const response = await service.handleToolCall('devchain_update_epic', {
      sessionId: '12345678',
      id: '00000000-0000-0000-0000-000000000001',
      version: 1,
      unrelated: true,
    });

    expect(response.error?.code).toBe('VALIDATION_ERROR');
    expect(response.error?.data).not.toHaveProperty('suggestions');
  });

  it('maps unexpected invocation errors to INTERNAL_ERROR', async () => {
    resolve.mockReturnValue({
      paramsSchema: null,
      invoke: jest.fn().mockRejectedValue(new Error('handler failed')),
    });

    await expect(service.handleToolCall('devchain_test', {})).resolves.toEqual({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'handler failed' },
    });
  });

  it('delegates resource requests to ResourceResolver', async () => {
    const response = { success: true as const, data: { uri: 'prompt://Welcome%20Prompt@2' } };
    const resolver = jest.spyOn(ResourceResolver.prototype, 'resolve').mockResolvedValue(response);

    await expect(service.handleResourceRequest('prompt://Welcome%20Prompt@2')).resolves.toEqual(
      response,
    );
    expect(resolver).toHaveBeenCalledWith('prompt://Welcome%20Prompt@2');
  });

  it('maps unexpected resource errors to INTERNAL_ERROR', async () => {
    jest
      .spyOn(ResourceResolver.prototype, 'resolve')
      .mockRejectedValue(new Error('storage failed'));

    await expect(service.handleResourceRequest('prompt://Welcome%20Prompt@2')).resolves.toEqual({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'storage failed' },
    });
  });
});

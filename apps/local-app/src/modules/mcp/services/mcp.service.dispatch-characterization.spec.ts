/**
 * Dispatch-boundary characterization tests for SERVICE_UNAVAILABLE.
 *
 * Unlike service-unavailable.characterization.spec.ts (which builds handler
 * contexts by hand), these tests exercise the real McpService.handleToolCall()
 * dispatch path with all optional deps left undefined — proving the null-adapter
 * pattern works end-to-end through the builders.
 *
 * Run: pnpm --filter local-app test -- --testPathPattern mcp.service.dispatch-characterization
 */

import { McpService } from './mcp.service';
import type { StorageService } from '../../storage/interfaces/storage.interface';
import type { McpResponse } from '../dtos/mcp.dto';

jest.mock('../../../common/logging/logger', () => ({
  createLogger: () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() }),
}));

const SESSION_ID = '00000000-0000-0000-0000-000000000001';

function createMinimalStorage(): StorageService {
  return {
    getFeatureFlags: () => ({}),
  } as unknown as StorageService;
}

function createStandaloneMcpService(): McpService {
  return new McpService(
    createMinimalStorage(),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
  );
}

function assertServiceUnavailable(result: McpResponse) {
  expect(result.success).toBe(false);
  expect(result.error).toBeDefined();
  expect(result.error!.code).toBe('SERVICE_UNAVAILABLE');
  expect(typeof result.error!.message).toBe('string');
  expect(result.error!.message.length).toBeGreaterThan(0);
}

describe('McpService dispatch-boundary SERVICE_UNAVAILABLE', () => {
  let service: McpService;

  beforeEach(() => {
    service = createStandaloneMcpService();
  });

  describe('chat binding group', () => {
    it('devchain_send_message returns SERVICE_UNAVAILABLE through dispatch', async () => {
      const result = await service.handleToolCall('devchain_send_message', {
        sessionId: SESSION_ID,
        message: 'hello',
        recipient: 'agents',
      });
      assertServiceUnavailable(result);
    });
  });

  describe('epic binding group', () => {
    it('devchain_get_epic_by_id returns SERVICE_UNAVAILABLE through dispatch', async () => {
      const result = await service.handleToolCall('devchain_get_epic_by_id', {
        sessionId: SESSION_ID,
        id: '00000000-0000-0000-0000-000000000099',
      });
      assertServiceUnavailable(result);
    });
  });

  describe('review binding group', () => {
    it('devchain_get_review returns SERVICE_UNAVAILABLE through dispatch', async () => {
      const result = await service.handleToolCall('devchain_get_review', {
        sessionId: SESSION_ID,
        reviewId: '00000000-0000-0000-0000-000000000099',
      });
      assertServiceUnavailable(result);
    });
  });

  describe('teams binding group', () => {
    it('devchain_team returns SERVICE_UNAVAILABLE through dispatch', async () => {
      const result = await service.handleToolCall('devchain_team', {
        sessionId: SESSION_ID,
      });
      assertServiceUnavailable(result);
    });
  });

  describe('structural contract', () => {
    it('SERVICE_UNAVAILABLE response has canonical shape { success: false, error: { code, message } }', async () => {
      const result = await service.handleToolCall('devchain_team', {
        sessionId: SESSION_ID,
      });

      expect(result).toEqual({
        success: false,
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: expect.any(String),
        },
      });
    });

    it('response is NOT a generic INTERNAL_ERROR (proves null-adapter is active, not TypeError)', async () => {
      const result = await service.handleToolCall('devchain_send_message', {
        sessionId: SESSION_ID,
        message: 'hello',
        recipient: 'agents',
      });

      expect(result.error!.code).not.toBe('INTERNAL_ERROR');
      expect(result.error!.code).toBe('SERVICE_UNAVAILABLE');
    });
  });
});

import { z } from 'zod';
import type { AgentTimeBufferSnapshot } from '../models/epic-time.models';
import type { EpicTimeService } from '../services/epic-time.service';
import { AgentTimeBufferController } from './agent-time-buffer.controller';

// Layer: backend unit. Controller tests prove strict transport validation and
// exact service projection; the eligibility matrix lives in the store suite.
describe('AgentTimeBufferController', () => {
  const projectId = '11111111-1111-4111-8111-111111111111';
  const agentId = '22222222-2222-4222-8222-222222222222';
  const targetEpicId = '33333333-3333-4333-8333-333333333333';
  const snapshot: AgentTimeBufferSnapshot = {
    capturedAt: '2026-01-02T00:00:00.000Z',
    items: [
      {
        agentId,
        snapshotToken: 'a'.repeat(64),
        minutes: 2,
        durationMs: 120_000,
        segmentCount: 2,
        oldestActivityAt: '2026-01-02T00:01:00.000Z',
        newestActivityAt: '2026-01-02T00:02:00.000Z',
      },
    ],
  };
  let service: {
    getAgentTimeBuffers: jest.Mock;
    assignAgentTimeBuffer: jest.Mock;
    resetAgentTimeBuffer: jest.Mock;
  };
  let controller: AgentTimeBufferController;

  beforeEach(() => {
    service = {
      getAgentTimeBuffers: jest.fn().mockReturnValue(snapshot),
      assignAgentTimeBuffer: jest.fn().mockResolvedValue({ workspaceId: 'workspace-1' }),
      resetAgentTimeBuffer: jest.fn().mockResolvedValue({ workspaceId: 'workspace-1' }),
    };
    controller = new AgentTimeBufferController(service as unknown as EpicTimeService);
  });

  it.each([
    ['an unknown field', { projectId, targetEpicId, capturedAt: snapshot.capturedAt, extra: 1 }],
    ['a non-UUID target Epic', { ...validBody(), targetEpicId: 'epic-1' }],
    ['a non-ISO capture watermark', { ...validBody(), capturedAt: 'not-a-timestamp' }],
    ['an uppercase token', { ...validBody(), snapshotToken: 'A'.repeat(64) }],
    ['a short token', { ...validBody(), snapshotToken: 'a'.repeat(63) }],
  ])('rejects %s on the assignment body', (_label, body) => {
    expect(() => controller.assignAgentTimeBuffer(agentId, body)).toThrow(z.ZodError);
    expect(service.assignAgentTimeBuffer).not.toHaveBeenCalled();
  });

  it.each([
    ['an unknown field', { projectId, capturedAt: '2026-01-02T00:00:00.000Z', extra: 1 }],
    ['a non-ISO capture watermark', { projectId, capturedAt: 'not-a-timestamp' }],
    [
      'an uppercase token',
      { projectId, capturedAt: '2026-01-02T00:00:00.000Z', snapshotToken: 'A'.repeat(64) },
    ],
    [
      'a short token',
      { projectId, capturedAt: '2026-01-02T00:00:00.000Z', snapshotToken: 'a'.repeat(63) },
    ],
  ])('rejects %s on the reset body', (_label, body) => {
    expect(() => controller.resetAgentTimeBuffer(agentId, body)).toThrow(z.ZodError);
    expect(service.resetAgentTimeBuffer).not.toHaveBeenCalled();
  });

  function validBody(): Record<string, string> {
    return {
      projectId,
      targetEpicId,
      capturedAt: '2026-01-02T00:00:00.000Z',
      snapshotToken: 'c'.repeat(64),
    };
  }
});

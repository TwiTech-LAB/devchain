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
  let service: { getAgentTimeBuffers: jest.Mock; assignAgentTimeBuffer: jest.Mock };
  let controller: AgentTimeBufferController;

  beforeEach(() => {
    service = {
      getAgentTimeBuffers: jest.fn().mockReturnValue(snapshot),
      assignAgentTimeBuffer: jest.fn().mockResolvedValue({ workspaceId: 'workspace-1' }),
    };
    controller = new AgentTimeBufferController(service as unknown as EpicTimeService);
  });

  it('returns the safe snapshot projection untouched', () => {
    expect(controller.getAgentTimeBuffers(projectId)).toBe(snapshot);
    expect(service.getAgentTimeBuffers).toHaveBeenCalledWith(projectId);
  });

  it('dispatches an assignment with the parsed strict body', async () => {
    const body = {
      projectId,
      targetEpicId,
      capturedAt: '2026-01-02T00:00:00.000Z',
      snapshotToken: 'b'.repeat(64),
    };
    await expect(controller.assignAgentTimeBuffer(agentId, body)).resolves.toEqual({
      workspaceId: 'workspace-1',
    });
    expect(service.assignAgentTimeBuffer).toHaveBeenCalledWith({
      agentId,
      ...body,
    });
  });

  it.each([
    ['missing projectId', undefined],
    ['non-UUID projectId', 'project-1'],
  ])('rejects %s on the snapshot read', (_label, value) => {
    expect(() => controller.getAgentTimeBuffers(value)).toThrow(z.ZodError);
    expect(service.getAgentTimeBuffers).not.toHaveBeenCalled();
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

  it('rejects an empty agent route parameter', () => {
    expect(() => controller.assignAgentTimeBuffer('', validBody())).toThrow(z.ZodError);
    expect(service.assignAgentTimeBuffer).not.toHaveBeenCalled();
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

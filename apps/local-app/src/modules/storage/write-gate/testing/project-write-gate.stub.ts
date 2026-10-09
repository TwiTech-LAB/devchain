import type { ProjectWriteGate } from '../project-write-gate';

export type ProjectWriteGateStub = jest.Mocked<
  Pick<
    ProjectWriteGate,
    'assertWritable' | 'isWritable' | 'getRemoteOwner' | 'refresh' | 'listNonWritableProjectIds'
  >
>;

/** Admits every write; override `assertWritable` to exercise a refusal. */
export function createProjectWriteGateStub(): ProjectWriteGateStub {
  return {
    assertWritable: jest.fn(),
    isWritable: jest.fn().mockReturnValue(true),
    getRemoteOwner: jest.fn().mockReturnValue(null),
    refresh: jest.fn().mockResolvedValue(undefined),
    listNonWritableProjectIds: jest.fn().mockReturnValue([]),
  };
}

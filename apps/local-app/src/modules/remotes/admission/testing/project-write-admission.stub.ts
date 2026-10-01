import type { ProjectWriteAdmissionService } from '../project-write-admission.service';

export type ProjectWriteAdmissionStub = jest.Mocked<
  Pick<
    ProjectWriteAdmissionService,
    | 'assertWritable'
    | 'isWritable'
    | 'getRemoteOwner'
    | 'refreshBindings'
    | 'listNonWritableProjectIds'
  >
>;

/** Admits every write; override `assertWritable` to exercise a refusal. */
export function createProjectWriteAdmissionStub(): ProjectWriteAdmissionStub {
  return {
    assertWritable: jest.fn(),
    isWritable: jest.fn().mockReturnValue(true),
    getRemoteOwner: jest.fn().mockReturnValue(null),
    refreshBindings: jest.fn().mockResolvedValue(undefined),
    listNonWritableProjectIds: jest.fn().mockReturnValue([]),
  };
}

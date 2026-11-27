import type { ProjectReplicaV1 } from '@devchain/shared';
import type { ProjectReplicaApplySummary } from '../../storage/interfaces/storage.interface';
import { ManagedProjectionLock } from '../../external-integrations/subscribers/managed-projection-lock';
import { ProjectReplicaApplier } from './project-replica.applier';

// Layer: module unit. The storage port returns the apply summary; the hint decision
// is the applier's own, so a fake storage and events port prove it without SQLite.
describe('ProjectReplicaApplier link view hint', () => {
  const replica = { workspace: { id: 'w1' } } as unknown as ProjectReplicaV1;
  const summary: ProjectReplicaApplySummary = {
    projectId: 'p1',
    changedEpicIds: ['e1'],
    deletedEpicIds: [],
    linkChangedEpicIds: [],
    skippedUnknownSkillCount: 0,
  };

  function applyWith(result: ProjectReplicaApplySummary) {
    const events = {
      prepareCommitted: jest.fn((name: string) => ({ name }) as never),
      emitCommitted: jest.fn(),
      publish: jest.fn().mockResolvedValue(undefined),
    };
    const storage = {
      applyProjectReplica: jest.fn(async (_replica, _mode, eventFactory) => {
        eventFactory(result);
        return [result];
      }),
    };
    const applier = new ProjectReplicaApplier(storage, events, new ManagedProjectionLock());
    return { events, done: applier.apply(replica, { mode: 'live', remoteId: 'r1', cursor: null }) };
  }

  it('sends the link view hint after an apply that changed links or deleted epics, and not otherwise', async () => {
    const unchanged = applyWith(summary);
    await unchanged.done;
    expect(unchanged.events.publish).not.toHaveBeenCalled();

    for (const result of [
      { ...summary, linkChangedEpicIds: ['e1'] },
      { ...summary, deletedEpicIds: ['e2'] },
    ]) {
      const { events, done } = applyWith(result);
      await done;
      expect(events.emitCommitted).toHaveBeenCalledTimes(1);
      expect(events.publish).toHaveBeenCalledWith('epic.time.scope.invalidated', {
        workspaceId: 'w1',
        externalLinks: true,
      });
    }
  });
});

import { ValidationError } from '../../../common/errors/error-types';
import type { StorageService } from '../../storage/interfaces/storage.interface';

export type SnapshotEpicAssignments = ReadonlyMap<string, string>;

type EpicReader = Pick<StorageService, 'listEpics'>;

async function* projectEpicPages(projectId: string, storage: EpicReader) {
  const limit = 1000;
  for (let offset = 0; ; offset += limit) {
    const { items } = await storage.listEpics(projectId, { limit, offset });
    if (items.length) yield items;
    if (items.length < limit) return;
  }
}

export async function captureSnapshotEpicAssignments(
  projectId: string,
  agents: ReadonlyArray<{ id: string; name: string }>,
  storage: EpicReader,
): Promise<SnapshotEpicAssignments> {
  const agentNames = new Map(agents.map(({ id, name }) => [id, name]));
  const assignments = new Map<string, string>();
  for await (const epics of projectEpicPages(projectId, storage)) {
    for (const epic of epics) {
      if (!epic.agentId) continue;
      const name = agentNames.get(epic.agentId);
      if (!name?.trim()) {
        throw new ValidationError(
          `Cannot back up assignment for epic "${epic.title}". Its agent is missing from the project snapshot.`,
        );
      }
      assignments.set(epic.id, name);
    }
  }
  return assignments;
}

export async function restoreSnapshotEpicAssignments(
  projectId: string,
  assignments: SnapshotEpicAssignments,
  recreatedAgents: ReadonlyMap<string, string>,
  storage: EpicReader & Pick<StorageService, 'updateEpic'>,
) {
  const updates: Array<{ epicId: string; agentId: string; version: number }> = [];
  let epicsTotal = 0;
  for await (const epics of projectEpicPages(projectId, storage)) {
    epicsTotal += epics.length;
    for (const epic of epics) {
      const name = assignments.get(epic.id);
      if (name === undefined) continue;
      const agentId = recreatedAgents.get(name.trim().toLowerCase());
      if (!agentId) {
        throw new ValidationError(
          `Cannot restore assignment for epic "${epic.title}". Agent "${name}" is missing from the restored roster.`,
        );
      }
      if (epic.agentId !== agentId)
        updates.push({ epicId: epic.id, agentId, version: epic.version });
    }
  }

  for (const { epicId, agentId, version } of updates) {
    await storage.updateEpic(epicId, { agentId }, version);
  }
  return { epicsTotal, epicsRemapped: updates.length, epicsCleared: 0 };
}

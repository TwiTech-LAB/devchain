import type { DockerDataGroupRecord } from '../operations/docker-import-inventory.store';
import type { DockerHandoffDataGroup } from './docker-handoff.store';
import { overlapsData } from './docker-data-groups';
import { userIdsDiffer } from './docker-ownership';
import { within } from './docker-plan-files';
import type {
  DockerDataGroup,
  DockerDataMembers,
  DockerDataRepresentation,
  DockerDataRepresentationGroup,
} from './docker-plan.dto';

export function desiredDataRepresentation(
  group: DockerDataGroup,
  members: DockerDataMembers = group,
): DockerDataRepresentation | undefined {
  if (!group.ownership) return undefined;
  const { home, vm } = group.ownership;
  const follows = group.ownershipConsumers
    ? group.ownershipConsumers.some(
        (consumer) =>
          consumer.ownership.class === 'follows-user' && overlapsData(consumer, members),
      )
    : group.ownership.class === 'follows-user';
  return {
    kind: follows && userIdsDiffer(group.ownership) ? 'mapped' : 'exact',
    home,
    vm,
  };
}

export function sameDataRepresentation(
  left: DockerDataRepresentation | undefined,
  right: DockerDataRepresentation | undefined,
): boolean {
  return Boolean(
    left &&
      right &&
      left.kind === right.kind &&
      left.home.uid === right.home.uid &&
      left.home.gid === right.home.gid &&
      left.vm.uid === right.vm.uid &&
      left.vm.gid === right.vm.gid,
  );
}

export function recordedDataRepresentation(
  members: DockerDataMembers,
  records: DockerDataRepresentationGroup[],
): DockerDataRepresentation | undefined {
  const matching = records.filter((record) => overlapsData(record, members));
  const representation = matching[0]?.representation;
  if (
    !representation ||
    !matching.every((record) => sameDataRepresentation(record.representation, representation)) ||
    !members.volumes.every((volume) =>
      matching.some((record) => record.volumes.includes(volume)),
    ) ||
    !members.bindPaths.every((path) =>
      matching.some((record) => record.bindPaths.some((parent) => within(parent, path))),
    )
  )
    return undefined;
  return representation;
}

export function dataRepresentationMatches(
  group: DockerDataGroup,
  records: DockerDataRepresentationGroup[],
): boolean {
  return resourceMembers(group).every((members) =>
    sameDataRepresentation(
      recordedDataRepresentation(members, records),
      desiredDataRepresentation(group, members),
    ),
  );
}

/** One member list per volume and per folder, the unit a representation is recorded for. */
export function resourceMembers(group: DockerDataMembers): DockerDataMembers[] {
  return [
    ...group.volumes.map((volume) => ({ volumes: [volume], bindPaths: [] })),
    ...group.bindPaths.map((path) => ({ volumes: [], bindPaths: [path] })),
  ];
}

/** Retained data takes its snapshot from records, never from the current consumers. */
export function splitDataRepresentations(
  group: DockerDataGroup,
  retained?: DockerDataGroupRecord[],
): DockerHandoffDataGroup[] {
  const groups = new Map<string, DockerHandoffDataGroup>();
  for (const members of resourceMembers(group)) {
    const representation = retained
      ? recordedDataRepresentation(members, retained)
      : desiredDataRepresentation(group, members);
    const prior = retained?.find((record) => overlapsData(record, members));
    const ownership = retained
      ? prior?.ownership
      : group.ownership && {
          ...group.ownership,
          class:
            representation?.kind === 'exact' && group.ownership.class === 'follows-user'
              ? ('exact' as const)
              : group.ownership.class,
        };
    const key = JSON.stringify([representation, ownership]);
    let part = groups.get(key);
    if (!part) {
      part = {
        ...group,
        volumes: [],
        bindPaths: [],
        ownership,
        representation,
      };
      groups.set(key, part);
    }
    part.volumes.push(...members.volumes);
    part.bindPaths.push(...members.bindPaths);
  }
  return [...groups.values()];
}

import type {
  DockerDataGroup,
  DockerDataMembers,
  DockerDataRepresentationGroup,
  DockerPlanItem,
} from '@/modules/remotes/docker/docker-plan.dto';
import { userIds } from '@/modules/remotes/vm-user-identity';

function overlaps(left: DockerDataMembers, right: DockerDataMembers): boolean {
  return (
    left.volumes.some((volume) => right.volumes.includes(volume)) ||
    left.bindPaths.some((path) =>
      right.bindPaths.some(
        (other) => path === other || path.startsWith(`${other}/`) || other.startsWith(`${path}/`),
      ),
    )
  );
}

export function ConnectDataOwners({
  item,
  groups,
}: {
  item: DockerPlanItem;
  groups: DockerDataGroup[];
}) {
  const parts = groups.flatMap((group): DockerDataRepresentationGroup[] => {
    const { ownership, ownershipConsumers: consumers } = group;
    if (!group.itemIds.includes(item.id) || !ownership || ownership.refusalReasons?.length)
      return [];
    const { home, vm } = ownership;
    if (home.uid === vm.uid && home.gid === vm.gid) return [];
    const own = consumers?.filter((consumer) => consumer.itemId === item.id);
    const ownerChanges = (members: DockerDataMembers): boolean =>
      (!own?.length || own.some((consumer) => overlaps(consumer, members))) &&
      (consumers
        ? consumers.some(
            (consumer) =>
              consumer.ownership.class === 'follows-user' && overlaps(consumer, members),
          )
        : ownership.class === 'follows-user');
    const volumes = group.volumes.filter((volume) =>
      ownerChanges({ volumes: [volume], bindPaths: [] }),
    );
    const bindPaths = group.bindPaths.filter((path) =>
      ownerChanges({ volumes: [], bindPaths: [path] }),
    );
    if (volumes.length === 0 && bindPaths.length === 0) return [];
    return [{ volumes, bindPaths, representation: { kind: 'mapped', home, vm } }];
  });
  return <DockerDataOwners parts={parts} direction="to-vm" />;
}

const OWNER_CHANGES = {
  'to-vm': { label: 'Data owners change to your VM user', side: 'vm' },
  'to-home': { label: 'Owners change to your user on this PC', side: 'home' },
} as const;

export function DockerDataOwners({
  parts,
  direction,
}: {
  parts: DockerDataRepresentationGroup[];
  direction: keyof typeof OWNER_CHANGES;
}) {
  const { label, side } = OWNER_CHANGES[direction];
  return parts.flatMap((part) => {
    if (part.representation?.kind !== 'mapped') return [];
    const target = part.representation[side];
    const resources = [...part.volumes, ...part.bindPaths];
    return (
      <p key={JSON.stringify(resources)} className="break-all">
        {label} ({userIds(target.uid, target.gid)}): {resources.join(', ')}.
      </p>
    );
  });
}

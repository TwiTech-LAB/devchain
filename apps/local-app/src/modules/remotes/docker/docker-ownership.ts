import type {
  DockerComposeUserSource,
  DockerDataMembers,
  DockerDataGroupCheck,
  DockerOwnershipContext,
  DockerOwnershipDecision,
  DockerOwnershipRecord,
  DockerPlanIssue,
  DockerPlanItem,
  DockerUserIds,
} from './docker-plan.dto';
import { overlapsData } from './docker-data-groups';

export interface DockerOwnershipConsumer extends DockerDataMembers {
  name: string;
  itemId?: string;
  user?: string;
  imageUser?: string;
  ownership: DockerOwnershipDecision;
  literalHomeUser?: boolean;
  /** Validated project counterpart retained unchanged or explicitly reset/replaced. */
  counterpart?: boolean;
}
interface ComposeUsers {
  source: DockerComposeUserSource;
  homeUser?: string;
  vmUser?: string;
  vmGroupAdd?: Array<string | number>;
}
export function dockerNumericUid(user: string | undefined): number | null {
  if (user === undefined) return null;
  const uid = user.split(':')[0];
  if (uid === '') return 0;
  return /^\d+$/.test(uid) && Number.isSafeInteger(Number(uid)) ? Number(uid) : null;
}
function matchesIds(user: string | undefined, ids: DockerUserIds): boolean {
  if (user === undefined || dockerNumericUid(user) !== ids.uid) return false;
  const gid = user.split(':')[1];
  return gid === undefined || gid === String(ids.gid);
}
export function classifyDockerOwnership(
  context: DockerOwnershipContext,
  user: string | undefined,
  imageUser: string | undefined,
  projectCode: boolean,
  compose?: ComposeUsers,
  isCompose = false,
  groupAdd: string[] = [],
): DockerOwnershipDecision {
  const ownership: DockerOwnershipDecision = {
    ...context,
    class: 'exact',
    ...(compose ? { compose: compose.source } : {}),
  };
  if (!userIdsDiffer(context)) return ownership;
  if (compose) {
    if (
      compose.homeUser !== compose.vmUser &&
      matchesIds(compose.homeUser, context.home) &&
      matchesIds(compose.vmUser, context.vm)
    ) {
      ownership.class = 'follows-user';
      ownership.target = {
        user: compose.vmUser!,
        groupAdd: (compose.vmGroupAdd ?? []).map(String),
      };
    } else if (
      projectCode &&
      matchesIds(compose.homeUser, context.home) &&
      matchesIds(compose.vmUser, context.home)
    ) {
      ownership.class = 'needs-user-fix';
    }
  } else if (
    !isCompose &&
    user !== undefined &&
    /^\d+$/.test(user.split(':')[0]) &&
    dockerNumericUid(user) === context.home.uid &&
    imageUser !== undefined &&
    user !== imageUser
  ) {
    ownership.class = 'follows-user';
    const [uid, gid] = user.split(':');
    const targetUser = [context.home.uid !== context.vm.uid ? String(context.vm.uid) : uid];
    if (gid !== undefined)
      targetUser.push(gid === String(context.home.gid) ? String(context.vm.gid) : gid);
    ownership.target = { user: targetUser.join(':'), groupAdd: [...groupAdd] };
  }
  if (
    ownership.class === 'exact' &&
    projectCode &&
    user !== undefined &&
    dockerNumericUid(user) === null &&
    user === imageUser
  )
    ownership.class = 'image-user-hint';
  return ownership;
}
export function literalHomeComposeUser(
  context: DockerOwnershipContext,
  homeUser: string | undefined,
  vmUser: string | undefined,
): boolean {
  return matchesIds(homeUser, context.home) && matchesIds(vmUser, context.home);
}

export function userIdsDiffer({ home, vm }: DockerOwnershipContext): boolean {
  return home.uid !== vm.uid || home.gid !== vm.gid;
}
/** An exact consumer may share follows-user data only as root or as a uid unrelated to both machines' users. */
export function exactUidAllowed(uid: number | null, context: DockerOwnershipContext): boolean {
  return uid !== null && (uid === 0 || (uid !== context.home.uid && uid !== context.vm.uid));
}

function sameIssue(left: DockerPlanIssue, right: DockerPlanIssue): boolean {
  return left.code === right.code && left.message === right.message;
}

/** Mapping is safe only when every retained consumer can use the resulting owners. */
export function applyDockerGroupOwnership(
  groups: DockerDataGroupCheck[],
  items: DockerPlanItem[],
  consumers: DockerOwnershipConsumer[],
  context: DockerOwnershipContext,
): void {
  for (const group of groups) {
    const holders = consumers.filter((consumer) => overlapsData(group, consumer));
    const followers = holders.filter((holder) => holder.ownership.class === 'follows-user');
    const follows = followers.length > 0;
    if (follows) {
      for (const holder of holders) {
        if (
          holder.ownership.class === 'exact' &&
          holder.literalHomeUser &&
          followers.some((follower) => overlapsData(holder, follower))
        )
          holder.ownership.class = 'needs-user-fix';
      }
    }
    const conflicts = follows
      ? holders.flatMap((holder) => {
          if (holder.counterpart || holder.ownership.class === 'follows-user') return [];
          if (!followers.some((follower) => overlapsData(holder, follower))) return [];
          if (holder.ownership.class === 'needs-user-fix')
            return [
              {
                code: 'ownership-consumer-conflict',
                message: `${holder.name}: fix and Verify the literal home user before sharing data whose owners follow the developer user. Move without the fix cannot resolve this ownership conflict.`,
              },
            ];
          const uid = dockerNumericUid(holder.user ?? holder.imageUser);
          if (exactUidAllowed(uid, context)) return [];
          return [
            {
              code: 'ownership-consumer-conflict',
              message: `${holder.name}: exact consumer ${uid === null ? 'has an unknown user id' : `runs as uid ${uid}`} and cannot share data whose owners follow the developer user.`,
            },
          ];
        })
      : [];
    const refusalReasons = [
      ...holders.flatMap((holder) => holder.ownership.refusalReasons ?? []),
      ...conflicts,
    ].filter(
      (issue, index, issues) => issues.findIndex((entry) => sameIssue(entry, issue)) === index,
    );
    let groupClass: DockerOwnershipDecision['class'] = 'exact';
    if (follows) groupClass = 'follows-user';
    else if (holders.some((holder) => holder.ownership.class === 'needs-user-fix'))
      groupClass = 'needs-user-fix';
    group.ownership = {
      ...context,
      class: groupClass,
      ...(refusalReasons.length ? { refusalReasons } : {}),
    };
    group.ownershipConsumers = holders.map((holder) => ({
      name: holder.name,
      ...(holder.itemId ? { itemId: holder.itemId } : {}),
      ownership: holder.ownership,
      volumes: holder.volumes,
      bindPaths: holder.bindPaths,
    }));
    for (const item of items.filter((item) => group.itemIds.includes(item.id))) {
      if (item.serviceOwnership?.some((entry) => entry.ownership.class === 'needs-user-fix'))
        item.ownership = { ...context, class: 'needs-user-fix' };
      for (const reason of refusalReasons)
        if (!item.blockers.some((issue) => sameIssue(issue, reason))) item.blockers.push(reason);
    }
  }
}

export function ownershipRecord(
  ownership: DockerOwnershipDecision | undefined,
  targetUser?: string,
): DockerOwnershipRecord | undefined {
  if (!ownership) return undefined;
  return {
    class: ownership.class,
    home: ownership.home,
    vm: ownership.vm,
    ...(targetUser !== undefined ? { targetUser } : {}),
  };
}

/** The runtime user the VM container should carry: the follows-user target, else the captured one. */
export function dockerTargetUser(
  item: Pick<DockerPlanItem, 'ownership' | 'runtimeUser'>,
): string | undefined {
  return item.ownership?.target?.user ?? item.runtimeUser;
}

/** Change only the follows-user runtime fields; captured settings remain untouched. */
export function dockerTargetConfig(
  config: Record<string, unknown>,
  ownership?: DockerOwnershipDecision,
): Record<string, unknown> {
  if (ownership?.class !== 'follows-user' || !ownership.target) return config;
  const { vm, target } = ownership;
  const targetEnv = (entry: string): string => {
    if (entry.startsWith('DEVCHAIN_UID=')) return `DEVCHAIN_UID=${vm.uid}`;
    if (entry.startsWith('DEVCHAIN_GID=')) return `DEVCHAIN_GID=${vm.gid}`;
    return entry;
  };
  return {
    ...config,
    User: target.user,
    HostConfig: { ...(config.HostConfig as object), GroupAdd: [...target.groupAdd] },
    ...(Array.isArray(config.Env) ? { Env: config.Env.map(targetEnv) } : {}),
  };
}

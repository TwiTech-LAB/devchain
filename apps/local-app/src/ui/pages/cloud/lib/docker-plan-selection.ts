import type {
  DockerDataChoice,
  DockerPlan,
  DockerPlanItem,
  DockerSelectionItem,
  DockerSelectionMode,
} from '@/modules/remotes/docker/docker-plan.dto';

export interface DockerPicks {
  included: Record<string, boolean>;
  modes: Record<string, DockerSelectionMode>;
  dataChoices: Record<string, DockerDataChoice>;
  privilegedAcceptance: Record<string, boolean>;
  userFixAcceptance: Record<string, boolean>;
}

export const emptyDockerPicks = (): DockerPicks => ({
  included: {},
  modes: {},
  dataChoices: {},
  privilegedAcceptance: {},
  userFixAcceptance: {},
});

export const needsUserFix = (item: DockerPlanItem): boolean =>
  item.ownership?.class === 'needs-user-fix';

/** The data choices the item offers; a plan that lists none offers keep or replace. */
export const dataChoicesOf = (item: DockerPlanItem): readonly DockerDataChoice[] =>
  item.dataChoices ?? ['keep-vm', 'replace-home'];

export function dockerSelection(
  items: readonly DockerPlanItem[],
  picks: DockerPicks,
): DockerSelectionItem[] {
  return items.flatMap((item) => {
    const mode = picks.modes[item.id] ?? item.choices[0];
    return picks.included[item.id] && mode && item.choices.includes(mode)
      ? [
          {
            id: item.id,
            mode,
            ...(picks.dataChoices[item.id] && { dataChoice: picks.dataChoices[item.id] }),
            ...(picks.privilegedAcceptance[item.id] && { acceptPrivileged: true as const }),
            ...(needsUserFix(item) &&
              picks.userFixAcceptance[item.id] && { moveWithoutUserFix: true as const }),
          },
        ]
      : [];
  });
}

const itemKey = (item: DockerPlanItem) =>
  JSON.stringify([item.kind, item.composeProject, item.name]);

/** Proposal ids change on each plan; the ownership being acknowledged must stay the same. */
function fixContext(item: DockerPlanItem): string {
  const decisions = [
    item.ownership,
    ...(item.serviceOwnership ?? []).map((entry) => entry.ownership),
  ];
  return JSON.stringify([
    item.runtimeUser,
    decisions.map(
      (decision) =>
        decision && {
          class: decision.class,
          home: decision.home,
          vm: decision.vm,
          compose: decision.compose,
          target: decision.target,
          oldUser: decision.fixProposal?.oldUser,
          newUser: decision.fixProposal?.newUser,
        },
    ),
  ]);
}

/** Keep existing picks only when the fresh plan still offers them. New items start unpicked. */
export function reconcileDockerPicks(
  plan: DockerPlan,
  previous: { plan: DockerPlan | null; picks: DockerPicks },
): { picks: DockerPicks; dropped: string[] } {
  const picks = emptyDockerPicks();
  const oldItems = new Map((previous.plan?.items ?? []).map((item) => [itemKey(item), item]));
  for (const item of plan.items) {
    const old = oldItems.get(itemKey(item));
    picks.included[item.id] =
      item.choices.length > 0 &&
      (old ? previous.picks.included[old.id] === true : !previous.plan && item.defaultSelected);
    const mode = old ? (previous.picks.modes[old.id] ?? old.selectedMode) : item.selectedMode;
    const nextMode = mode && item.choices.includes(mode) ? mode : item.choices[0];
    if (nextMode) picks.modes[item.id] = nextMode;
    const data = old && previous.picks.dataChoices[old.id];
    if (data && dataChoicesOf(item).includes(data)) picks.dataChoices[item.id] = data;
    if (old && previous.picks.privilegedAcceptance[old.id])
      picks.privilegedAcceptance[item.id] = true;
    if (
      old &&
      needsUserFix(item) &&
      previous.picks.userFixAcceptance[old.id] &&
      fixContext(old) === fixContext(item)
    )
      picks.userFixAcceptance[item.id] = true;
  }
  const keys = new Set(plan.items.map(itemKey));
  return {
    picks,
    dropped: (previous.plan?.items ?? [])
      .filter((item) => previous.picks.included[item.id] && !keys.has(itemKey(item)))
      .map((item) => item.name),
  };
}

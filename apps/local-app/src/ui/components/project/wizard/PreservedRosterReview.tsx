import type { PreservationAgentRow } from '@/common/project-preservation.contract';
import { Badge } from '@/ui/components/ui/badge';
import { Checkbox } from '@/ui/components/ui/checkbox';
import { cn } from '@/ui/lib/utils';
import { AgentOptionPicker } from './AgentSetupRow';
import { agentKey } from './agentPlan';
import {
  automaticOptionChanges,
  preservedAgentGroups,
  updatePreservationAdditions,
  type PreservationAddition,
} from './currentSetup';
import { useCurrentSetup } from './KeepCurrentSetup';
import {
  ReviewSection,
  ROSTER_SCROLL_CLASS,
  RosterGroup,
  SummaryLine,
} from './SetupReviewSections';

function PreservedAgentRow({ agent }: { agent: PreservationAgentRow }) {
  const { onUpdateChoices } = useCurrentSetup();
  const agentNameKey = agentKey(agent.name);
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 py-2">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="min-w-0 break-words text-sm font-medium">{agent.name}</span>
        {agent.status !== 'kept' && (
          <Badge variant="secondary">{agent.status === 'changed' ? 'Changed' : 'New'}</Badge>
        )}
      </div>
      <AgentOptionPicker
        agentName={agent.name}
        selected={
          agent.option
            ? { name: agent.option.configName, providerName: agent.option.providerName }
            : null
        }
        options={agent.eligibleOptions.map(({ configName, providerName }) => ({
          name: configName,
          providerName,
        }))}
        onSelect={({ name, providerName }) =>
          onUpdateChoices((choices) => ({
            ...choices,
            agentOptions: [
              ...(choices.agentOptions ?? []).filter(
                ({ agentName }) => agentKey(agentName) !== agentNameKey,
              ),
              { agentName: agent.name, configName: name, providerName },
            ],
          }))
        }
      />
    </li>
  );
}

function PreservedAgentGroup({
  name,
  agents,
  permissionsChanged,
}: {
  name: string;
  agents: PreservationAgentRow[];
  permissionsChanged?: boolean;
}) {
  return (
    <RosterGroup
      title={name}
      headingLevel={3}
      // An outline badge stays visible on the tinted header band.
      badge={permissionsChanged && <Badge variant="outline">Changed</Badge>}
      description={permissionsChanged && 'Some allowed options are not in this template.'}
    >
      {agents.length > 0 && (
        <ul className="divide-y">
          {agents.map((agent) => (
            <PreservedAgentRow key={agentKey(agent.name)} agent={agent} />
          ))}
        </ul>
      )}
    </RosterGroup>
  );
}

export function OptionalAdditions() {
  const current = useCurrentSetup();
  const plan = current.plan;
  if (!plan || (!plan.additions.teams.length && !plan.additions.members.length)) return null;
  const setAddition = (addition: PreservationAddition, selected: boolean) =>
    current.onUpdateChoices((choices) =>
      updatePreservationAdditions(choices, plan, addition, selected),
    );
  return (
    <ReviewSection title="Optional template additions">
      <div className="grid gap-2">
        {plan.additions.teams.map((team) => (
          <label key={team.name} className="flex items-start gap-2 rounded-md border p-2 text-sm">
            <Checkbox
              aria-label={`Add team ${team.name}`}
              checked={current.choices.addTeams?.includes(team.name) ?? false}
              onCheckedChange={(value) => setAddition({ teamName: team.name }, value === true)}
            />
            <span>
              <span className="block">{team.name}</span>
              <span className="block text-xs text-muted-foreground">
                {team.teamLeadAgentName ? `Lead: ${team.teamLeadAgentName} · ` : ''}
                Members: {team.memberAgentNames.join(', ')}
              </span>
            </span>
          </label>
        ))}
        {plan.additions.members.map(({ teamName, agentName }) => (
          <label
            key={JSON.stringify([teamName, agentName])}
            className="flex items-center gap-2 rounded-md border p-2 text-sm"
          >
            <Checkbox
              checked={
                current.choices.addMembers?.some(
                  (entry) => entry.teamName === teamName && entry.agentName === agentName,
                ) ?? false
              }
              onCheckedChange={(value) => setAddition({ teamName, agentName }, value === true)}
            />
            Add {agentName} to {teamName}
          </label>
        ))}
      </div>
    </ReviewSection>
  );
}

export function PreservedRosterReview() {
  const { plan, choices } = useCurrentSetup();
  if (!plan) return null;
  const { teams, independent } = preservedAgentGroups(plan);

  return (
    <>
      {(teams.length > 0 || independent.length > 0) && (
        <div className={cn('space-y-4', ROSTER_SCROLL_CLASS)}>
          {teams.map(({ name, permissionsChanged, agents }) => (
            <PreservedAgentGroup
              key={agentKey(name)}
              name={name}
              permissionsChanged={permissionsChanged}
              agents={agents}
            />
          ))}
          {independent.length > 0 && (
            <PreservedAgentGroup name="Independent" agents={independent} />
          )}
        </div>
      )}
      <SummaryLine label="Changed" items={automaticOptionChanges(plan, choices)} />
    </>
  );
}

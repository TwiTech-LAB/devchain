import type { PreservationAgentRow } from '@/common/project-preservation.contract';
import { Badge } from '@/ui/components/ui/badge';
import { Checkbox } from '@/ui/components/ui/checkbox';
import { cn } from '@/ui/lib/utils';
import { AgentOptionPicker } from './AgentSetupRow';
import { agentKey } from './agentPlan';
import {
  addedTeamNames,
  automaticOptionChanges,
  preservedAgentGroups,
  updatePreservationAdditions,
  type PreservationAddition,
} from './currentSetup';
import { useCurrentSetup } from './KeepCurrentSetup';
import { ROSTER_SCROLL_CLASS, RosterGroup, RosterRow, rosterRole, type RosterRole } from './Roster';
import { ReviewSection, SummaryLine } from './SetupReviewSections';
import { useSetupReview } from './SetupReviewContext';

type PreservedAgent = PreservationAgentRow & { description: string | null };

function PreservedAgentRow({ agent, role }: { agent: PreservedAgent; role?: RosterRole }) {
  const { onUpdateChoices } = useCurrentSetup();
  const agentNameKey = agentKey(agent.name);
  return (
    <RosterRow
      name={agent.name}
      role={role}
      description={agent.description}
      badge={
        agent.status !== 'kept' && (
          <Badge variant="secondary">{agent.status === 'changed' ? 'Changed' : 'New'}</Badge>
        )
      }
    >
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
    </RosterRow>
  );
}

function PreservedAgentGroup({
  name,
  description,
  lead = null,
  agents,
  permissionsChanged,
}: {
  name: string;
  description?: string | null;
  /** The name of the lead's row in `agents`, or null when the block shows no lead row. */
  lead?: string | null;
  agents: PreservedAgent[];
  permissionsChanged?: boolean;
}) {
  return (
    <RosterGroup
      title={name}
      // An outline badge stays visible on the tinted header band.
      badge={permissionsChanged && <Badge variant="outline">Changed</Badge>}
      description={description}
      note={permissionsChanged && 'Some allowed options are not in this template.'}
    >
      {agents.length > 0 && (
        <ul className="divide-y">
          {agents.map((agent) => (
            <PreservedAgentRow
              key={agentKey(agent.name)}
              agent={agent}
              role={rosterRole(lead, agent.name)}
            />
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
              checked={addedTeamNames(current.choices, plan).includes(team.name)}
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
  const { plan, choices, currentExport } = useCurrentSetup();
  const { preview } = useSetupReview();
  if (!plan) return null;
  const { teams, independent } = preservedAgentGroups(plan, currentExport, preview.payload);

  return (
    <>
      {(teams.length > 0 || independent.length > 0) && (
        <ReviewSection title="Teams and agents">
          <div className={cn('space-y-4', ROSTER_SCROLL_CLASS)}>
            {teams.map(({ name, description, permissionsChanged, lead, agents }) => (
              <PreservedAgentGroup
                key={agentKey(name)}
                name={name}
                description={description}
                lead={lead}
                permissionsChanged={permissionsChanged}
                agents={agents}
              />
            ))}
            {independent.length > 0 && (
              <PreservedAgentGroup name="Independent" agents={independent} />
            )}
          </div>
        </ReviewSection>
      )}
      <SummaryLine label="Changed" items={automaticOptionChanges(plan, choices)} />
    </>
  );
}

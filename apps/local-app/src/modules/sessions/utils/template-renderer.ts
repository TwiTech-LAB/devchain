import { renderTemplate } from '@/common/template/handlebars-renderer';
import type { Team } from '@/modules/storage/models/domain.models';

export interface InitialPromptTemplateContext {
  agentName: string;
  projectName: string;
  epicTitle?: string | null;
  providerName: string;
  profileName: string;
  sessionId: string;
  teamName: string;
  teamNames: string;
  isTeamLead: boolean;
}

type SupportedVariable =
  | 'agent_name'
  | 'project_name'
  | 'epic_title'
  | 'provider_name'
  | 'profile_name'
  | 'session_id'
  | 'session_id_short'
  | 'team_name'
  | 'team_names'
  | 'is_team_lead';

const SUPPORTED_VARIABLES: Record<
  SupportedVariable,
  (context: InitialPromptTemplateContext) => unknown
> = {
  agent_name: (context) => context.agentName,
  project_name: (context) => context.projectName,
  epic_title: (context) => context.epicTitle ?? '',
  provider_name: (context) => context.providerName,
  profile_name: (context) => context.profileName,
  session_id: (context) => context.sessionId,
  session_id_short: (context) => context.sessionId?.slice(0, 8) ?? '',
  team_name: (context) => context.teamName,
  team_names: (context) => context.teamNames,
  is_team_lead: (context) => context.isTeamLead,
};

const LEGACY_VARIABLES = Object.keys(SUPPORTED_VARIABLES) as SupportedVariable[];

export function renderInitialPromptTemplate(
  template: string,
  context: InitialPromptTemplateContext,
): string {
  if (template.trim().length === 0) {
    return '';
  }

  const vars: Record<string, unknown> = {};
  for (const [key, resolver] of Object.entries(SUPPORTED_VARIABLES)) {
    vars[key] = resolver(context);
  }

  return renderTemplate(template, vars, LEGACY_VARIABLES);
}

export function buildInitialPromptContext(params: {
  agent: { name: string; id?: string };
  project: { name: string };
  epic?: { title: string | null } | null;
  provider: { name: string };
  profile: { name: string };
  sessionId: string;
  teams?: Team[];
}): InitialPromptTemplateContext {
  const teams = params.teams ?? [];
  const sorted = teams.slice().sort((a, b) => a.name.localeCompare(b.name));

  return {
    agentName: params.agent.name,
    projectName: params.project.name,
    epicTitle: params.epic?.title ?? null,
    providerName: params.provider.name,
    profileName: params.profile.name,
    sessionId: params.sessionId,
    teamName: sorted.length === 1 ? sorted[0].name : '',
    teamNames: sorted.map((t) => t.name).join(', '),
    isTeamLead: params.agent.id ? sorted.some((t) => t.teamLeadAgentId === params.agent.id) : false,
  };
}

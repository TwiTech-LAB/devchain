export interface InitialPromptTemplateContext {
  agentName: string;
  projectName: string;
  epicTitle?: string | null;
  providerName: string;
  profileName: string;
  sessionId: string;
}

type SupportedVariable =
  | 'agent_name'
  | 'project_name'
  | 'epic_title'
  | 'provider_name'
  | 'profile_name'
  | 'session_id'
  | 'session_id_short';

const SUPPORTED_VARIABLES: Record<
  SupportedVariable,
  (context: InitialPromptTemplateContext) => string
> = {
  agent_name: (context) => context.agentName,
  project_name: (context) => context.projectName,
  epic_title: (context) => context.epicTitle ?? '',
  provider_name: (context) => context.providerName,
  profile_name: (context) => context.profileName,
  session_id: (context) => context.sessionId,
  session_id_short: (context) => context.sessionId?.slice(0, 8) ?? '',
};

const TOKEN_REGEX = /\{([a-z_]+)(\?)?\}/gi;

export function renderInitialPromptTemplate(
  template: string,
  context: InitialPromptTemplateContext,
): string {
  if (template.trim().length === 0) {
    return '';
  }

  return template.replace(TOKEN_REGEX, (match, variable: string) => {
    const key = variable.toLowerCase() as SupportedVariable;
    const resolver = SUPPORTED_VARIABLES[key];
    if (!resolver) {
      return match;
    }

    const value = resolver(context);
    return value ?? '';
  });
}

export function buildInitialPromptContext(params: {
  agent: { name: string };
  project: { name: string };
  epic?: { title: string | null } | null;
  provider: { name: string };
  profile: { name: string };
  sessionId: string;
}): InitialPromptTemplateContext {
  return {
    agentName: params.agent.name,
    projectName: params.project.name,
    epicTitle: params.epic?.title ?? null,
    providerName: params.provider.name,
    profileName: params.profile.name,
    sessionId: params.sessionId,
  };
}

export interface FamilyAlternative {
  familySlug: string;
  defaultProvider: string;
  defaultProviderAvailable: boolean;
  availableProviders: string[];
  hasAlternatives: boolean;
}

export interface PreservationOption {
  configName: string;
  providerName: string;
}

export interface PreservationProfilePermission {
  profileName: string;
  /** An empty list allows all options of this profile. */
  configNames: string[];
}

export interface TeamPermissionChoice {
  teamName: string;
  allowTeamLeadCreateAgents?: boolean;
  profiles?: PreservationProfilePermission[];
}

export interface PreserveTeamSetup {
  addTeams?: string[];
  addMembers?: Array<{ teamName: string; agentName: string }>;
  agentOptions?: Array<{ agentName: string } & PreservationOption>;
  teamPermissions?: TeamPermissionChoice[];
}

export interface PreservationField {
  value: string | null;
  source: 'template-agent' | 'template-option' | 'retained' | 'unset';
}

export type PreservationAgentIssueCode =
  | 'preserve_profile_missing'
  | 'preserve_option_required'
  | 'preserve_option_unavailable'
  | 'preserve_no_eligible_options';

export type PreservationIssue =
  | {
      code: PreservationAgentIssueCode;
      message: string;
      details: { agentName: string; profileName: string | null };
    }
  | {
      code: 'preserve_invalid_addition' | 'preserve_team_roster' | 'preserve_team_permissions';
      message: string;
      details: { teamName: string; agentName?: string; profileName?: string };
    }
  | {
      code: 'preserve_unknown_agent' | 'preserve_multiple_owners';
      message: string;
      details: { agentNames: string[] };
    }
  | {
      code: 'preserve_ambiguous_options';
      message: string;
      details: { profileName: string; configNames: string[] };
    }
  | {
      code: 'preserve_profile_conflict';
      message: string;
      details: {
        field: 'id' | 'name' | 'familySlug' | 'optionPosition';
        profileNames: string[];
        value: string | number;
      };
    }
  | {
      code: 'preserve_profile_reference';
      message: string;
      details: { watcherName: string; profileName: string | null };
    }
  | {
      code: 'preserve_agent_reference';
      message: string;
      details: { agentName: string; section: 'watchers' | 'scheduledEpics'; name: string };
    };

export interface PreservationAgentRow {
  name: string;
  profileName: string | null;
  status: 'kept' | 'changed' | 'new';
  reason?: PreservationAgentIssueCode | 'option_changed';
  currentOption: PreservationOption | null;
  option: PreservationOption | null;
  eligibleOptions: PreservationOption[];
  model: PreservationField;
  effort: PreservationField;
}

export interface PreservationTeamRow {
  name: string;
  retained: boolean;
  teamLeadAgentName: string | null;
  memberAgentNames: string[];
  maxMembers: number;
  maxConcurrentTasks: number;
  allowTeamLeadCreateAgents: boolean;
  permissions: PreservationProfilePermission[];
  permissionsChanged: boolean;
}

export interface PreservationReview {
  agents: PreservationAgentRow[];
  teams: PreservationTeamRow[];
  eligiblePermissions: Array<{ profileName: string; options: PreservationOption[] }>;
  additions: {
    teams: Array<{
      name: string;
      teamLeadAgentName: string | null;
      memberAgentNames: string[];
      selected: boolean;
    }>;
    members: Array<{ teamName: string; agentName: string; selected: boolean }>;
  };
  familyAlternatives: FamilyAlternative[];
}

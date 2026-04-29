import { fetchJsonOrThrow, fetchOrThrow } from '@/ui/lib/sessions';

export interface TeamListItem {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  teamLeadAgentId: string | null;
  teamLeadAgentName: string | null;
  maxMembers: number;
  maxConcurrentTasks: number;
  allowTeamLeadCreateAgents: boolean;
  memberCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface TeamMember {
  agentId: string;
  agentName: string | null;
  isLead: boolean;
  createdAt: string;
}

export interface TeamDetail {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  teamLeadAgentId: string | null;
  teamLeadAgentName: string | null;
  maxMembers: number;
  maxConcurrentTasks: number;
  allowTeamLeadCreateAgents: boolean;
  members: TeamMember[];
  profileIds: string[];
  profileConfigSelections: Array<{ profileId: string; configIds: string[] }>;
  createdAt: string;
  updatedAt: string;
}

export interface ListResult<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface CreateTeamPayload {
  projectId: string;
  name: string;
  description?: string | null;
  teamLeadAgentId: string | null;
  maxMembers?: number;
  maxConcurrentTasks?: number;
  allowTeamLeadCreateAgents?: boolean;
  memberAgentIds: string[];
  profileIds?: string[];
  profileConfigSelections?: Array<{ profileId: string; configIds: string[] }>;
}

export interface UpdateTeamPayload {
  name?: string;
  description?: string | null;
  teamLeadAgentId?: string | null;
  maxMembers?: number;
  maxConcurrentTasks?: number;
  allowTeamLeadCreateAgents?: boolean;
  memberAgentIds?: string[];
  profileIds?: string[];
  profileConfigSelections?: Array<{ profileId: string; configIds: string[] }>;
}

export function isConfigurableTeam(team: { allowTeamLeadCreateAgents?: boolean }): boolean {
  return team.allowTeamLeadCreateAgents === true;
}

export function filterConfigurableTeams<T extends { allowTeamLeadCreateAgents?: boolean }>(
  teams: T[],
): T[] {
  return teams.filter(isConfigurableTeam);
}

export const teamsQueryKeys = {
  teams: (projectId: string) => ['teams', projectId] as const,
  detail: (teamId: string) => ['teams', 'detail', teamId] as const,
};

export async function fetchTeams(projectId: string): Promise<ListResult<TeamListItem>> {
  return fetchJsonOrThrow<ListResult<TeamListItem>>(
    `/api/teams?projectId=${encodeURIComponent(projectId)}`,
  );
}

export async function fetchTeamDetail(teamId: string): Promise<TeamDetail> {
  return fetchJsonOrThrow<TeamDetail>(`/api/teams/${encodeURIComponent(teamId)}`);
}

export async function createTeam(data: CreateTeamPayload): Promise<TeamDetail> {
  return fetchJsonOrThrow<TeamDetail>('/api/teams', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

export async function updateTeam(id: string, data: UpdateTeamPayload): Promise<TeamDetail> {
  return fetchJsonOrThrow<TeamDetail>(`/api/teams/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

export async function disbandTeam(id: string): Promise<void> {
  await fetchOrThrow(`/api/teams/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

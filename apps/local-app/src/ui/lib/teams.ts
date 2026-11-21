import { fetchJsonOrThrow, fetchOrThrow, type FetchFn } from '@/ui/lib/http-json';
import type { ListResult } from '@/modules/storage/interfaces/storage.interface';
import type { QueryClient } from '@tanstack/react-query';

export type { ListResult };

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

const teamDetailsKey = ['teams', 'detail'] as const;

export const teamsQueryKeys = {
  teams: (projectId: string) => ['teams', projectId] as const,
  allTeams: (projectId: string) => ['teams', projectId, 'all'] as const,
  details: teamDetailsKey,
  detail: (teamId: string) => [...teamDetailsKey, teamId] as const,
};

export async function invalidateProjectTeams(queryClient: QueryClient, projectId: string) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: teamsQueryKeys.teams(projectId) }),
    queryClient.invalidateQueries({ queryKey: teamsQueryKeys.details }),
  ]);
}

export async function fetchTeams(
  projectId: string,
  fetchFn: FetchFn,
  offset = 0,
): Promise<ListResult<TeamListItem>> {
  const page = offset > 0 ? `&offset=${offset}` : '';
  return fetchJsonOrThrow<ListResult<TeamListItem>>(
    `/api/teams?projectId=${encodeURIComponent(projectId)}${page}`,
    {},
    undefined,
    fetchFn,
  );
}

/** Reads every page of the project's team list. */
export async function fetchAllTeams(projectId: string, fetchFn: FetchFn): Promise<TeamListItem[]> {
  const first = await fetchTeams(projectId, fetchFn);
  const teams = [...first.items];
  while (teams.length < first.total) {
    const page = await fetchTeams(projectId, fetchFn, teams.length);
    if (page.items.length === 0) break;
    teams.push(...page.items);
  }
  return [...new Map(teams.map((team) => [team.id, team])).values()];
}

export async function fetchTeamDetail(teamId: string, fetchFn: FetchFn): Promise<TeamDetail> {
  return fetchJsonOrThrow<TeamDetail>(
    `/api/teams/${encodeURIComponent(teamId)}`,
    {},
    undefined,
    fetchFn,
  );
}

export async function createTeam(data: CreateTeamPayload, fetchFn: FetchFn): Promise<TeamDetail> {
  return fetchJsonOrThrow<TeamDetail>(
    '/api/teams',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    },
    undefined,
    fetchFn,
  );
}

export async function updateTeam(
  id: string,
  data: UpdateTeamPayload,
  fetchFn: FetchFn,
): Promise<TeamDetail> {
  return fetchJsonOrThrow<TeamDetail>(
    `/api/teams/${encodeURIComponent(id)}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    },
    undefined,
    fetchFn,
  );
}

export async function disbandTeam(id: string, fetchFn: FetchFn): Promise<void> {
  await fetchOrThrow(
    `/api/teams/${encodeURIComponent(id)}`,
    { method: 'DELETE' },
    undefined,
    fetchFn,
  );
}

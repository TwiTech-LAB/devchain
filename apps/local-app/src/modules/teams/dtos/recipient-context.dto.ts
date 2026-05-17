export type TeamMemberRole = 'lead' | 'member' | null;

export interface RecipientContext {
  isTeamLead: boolean;
  teamNames: string[];
  memberRole: TeamMemberRole;
}

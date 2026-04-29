import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, Crown, Loader2, Pencil, Plus, Trash2, Users, UsersRound } from 'lucide-react';

import { ConfirmDialog, EmptyState, PageHeader } from '@/ui/components/shared';
import { Avatar, AvatarFallback, AvatarImage } from '@/ui/components/ui/avatar';
import { Badge } from '@/ui/components/ui/badge';
import { Button } from '@/ui/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/ui/components/ui/card';
import { Checkbox } from '@/ui/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/components/ui/dialog';
import { Input } from '@/ui/components/ui/input';
import { Label } from '@/ui/components/ui/label';
import { ScrollArea } from '@/ui/components/ui/scroll-area';
import { Skeleton } from '@/ui/components/ui/skeleton';
import { Slider } from '@/ui/components/ui/slider';
import { Textarea } from '@/ui/components/ui/textarea';
import { useToast } from '@/ui/hooks/use-toast';
import { useSelectedProject } from '@/ui/hooks/useProjectSelection';
import { getAgentAvatarDataUri, getAgentInitials } from '@/ui/lib/multiavatar';
import {
  createTeam,
  disbandTeam,
  fetchTeamDetail,
  fetchTeams,
  teamsQueryKeys,
  type CreateTeamPayload,
  type ListResult,
  type TeamListItem,
  type UpdateTeamPayload,
  updateTeam,
} from '@/ui/lib/teams';
import { fetchJsonOrThrow } from '@/ui/lib/sessions';
import {
  type ProfileSelection,
  type ConfigItem,
} from '@/ui/components/team/ProviderGroupedConfigSelector';
import { ProviderConfigGranularSelector } from '@/ui/components/team/ProviderConfigGranularSelector';

// ── Types ────────────────────────────────────────────────

interface AgentListItem {
  id: string;
  name: string;
}

interface ProfileListItem {
  id: string;
  name: string;
}

interface TeamFormData {
  name: string;
  description: string | null;
  teamLeadAgentId: string | null;
  maxMembers: number;
  maxConcurrentTasks: number;
  allowTeamLeadCreateAgents: boolean;
  memberAgentIds: string[];
  profileIds: string[];
  profileConfigSelections: Array<{ profileId: string; configIds: string[] }>;
}

async function fetchProjectAgents(projectId: string): Promise<ListResult<AgentListItem>> {
  return fetchJsonOrThrow<ListResult<AgentListItem>>(
    `/api/agents?projectId=${encodeURIComponent(projectId)}`,
  );
}

async function fetchProjectProfiles(projectId: string): Promise<ListResult<ProfileListItem>> {
  return fetchJsonOrThrow<ListResult<ProfileListItem>>(
    `/api/profiles?projectId=${encodeURIComponent(projectId)}`,
  );
}

// ── Team Form Dialog ─────────────────────────────────────

const NATIVE_SELECT_CLASS =
  'flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50';

interface TeamFormDialogProps {
  mode: 'create' | 'edit';
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (data: TeamFormData) => void;
  isSubmitting: boolean;
  agents: AgentListItem[];
  agentsReady: boolean;
  profiles: ProfileListItem[];
  existingTeamNames: string[];
  initialData?: TeamFormData;
  editTeamName?: string;
}

function TeamFormDialog({
  mode,
  open,
  onOpenChange,
  onSubmit,
  isSubmitting,
  agents,
  agentsReady,
  profiles,
  existingTeamNames,
  initialData,
  editTeamName,
}: TeamFormDialogProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [selectedMemberIds, setSelectedMemberIds] = useState<string[]>([]);
  const [teamLeadAgentId, setTeamLeadAgentId] = useState<string | null>(null);
  const [selectedProfileIds, setSelectedProfileIds] = useState<string[]>([]);
  const [profileSelections, setProfileSelections] = useState<
    Array<{ profileId: string; configIds: string[] }>
  >([]);
  const [showConfigModal, setShowConfigModal] = useState(false);
  const [formTouched, setFormTouched] = useState(false);
  const [maxMembers, setMaxMembers] = useState(5);
  const [maxConcurrentTasks, setMaxConcurrentTasks] = useState(5);
  const [allowTeamLeadCreateAgents, setAllowTeamLeadCreateAgents] = useState(false);

  useEffect(() => {
    if (!open) return;
    setFormTouched(false);
    if (mode === 'create') {
      setName('');
      setDescription('');
      setSelectedMemberIds([]);
      setTeamLeadAgentId(null);
      setSelectedProfileIds([]);
      setProfileSelections([]);
      setMaxMembers(5);
      setMaxConcurrentTasks(5);
      setAllowTeamLeadCreateAgents(false);
    } else if (initialData) {
      setName(initialData.name);
      setDescription(initialData.description ?? '');
      setSelectedMemberIds(initialData.memberAgentIds);
      setTeamLeadAgentId(initialData.teamLeadAgentId);
      setSelectedProfileIds(initialData.profileIds ?? []);
      setProfileSelections(initialData.profileConfigSelections ?? []);
      setMaxMembers(initialData.maxMembers);
      setMaxConcurrentTasks(initialData.maxConcurrentTasks);
      setAllowTeamLeadCreateAgents(initialData.allowTeamLeadCreateAgents);
    }
  }, [open, mode, initialData]);

  const allowedIds = useMemo(() => new Set(agents.map((a) => a.id)), [agents]);

  useEffect(() => {
    if (!open || !agentsReady) return;
    setSelectedMemberIds((prev) => {
      const pruned = prev.filter((id) => allowedIds.has(id));
      return pruned.length !== prev.length ? pruned : prev;
    });
    setTeamLeadAgentId((prev) => (prev !== null && !allowedIds.has(prev) ? null : prev));
  }, [open, agentsReady, allowedIds]);

  function handleMemberToggle(agentId: string, checked: boolean) {
    setFormTouched(true);
    setSelectedMemberIds((prev) => {
      const next = checked ? [...prev, agentId] : prev.filter((id) => id !== agentId);
      if (!checked && teamLeadAgentId === agentId) {
        setTeamLeadAgentId(null);
      }
      return next;
    });
  }

  const trimmedName = name.trim();
  const isDuplicateName =
    trimmedName.length > 0 &&
    existingTeamNames.some(
      (n) =>
        n.toLowerCase() === trimmedName.toLowerCase() &&
        (mode === 'create' || n.toLowerCase() !== editTeamName?.toLowerCase()),
    );
  const canSubmit =
    trimmedName.length > 0 &&
    !isDuplicateName &&
    selectedMemberIds.length > 0 &&
    selectedMemberIds.every((id) => allowedIds.has(id)) &&
    teamLeadAgentId !== null &&
    allowedIds.has(teamLeadAgentId) &&
    selectedMemberIds.includes(teamLeadAgentId) &&
    !isSubmitting;

  const selectedMembers = agents.filter((a) => selectedMemberIds.includes(a.id));

  function handleProfileToggle(profileId: string, checked: boolean) {
    setSelectedProfileIds((prev) =>
      checked ? [...prev, profileId] : prev.filter((id) => id !== profileId),
    );
    if (!checked) {
      setProfileSelections((prev) => prev.filter((s) => s.profileId !== profileId));
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    onSubmit({
      name: trimmedName,
      description: description.trim() || null,
      teamLeadAgentId,
      maxMembers,
      maxConcurrentTasks,
      allowTeamLeadCreateAgents,
      memberAgentIds: selectedMemberIds.filter((id) => allowedIds.has(id)),
      profileIds: selectedProfileIds,
      profileConfigSelections: profileSelections,
    });
  }

  const isEditLoading = mode === 'edit' && !initialData;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>{mode === 'create' ? 'Create Team' : 'Edit Team'}</DialogTitle>
          <DialogDescription>
            {mode === 'create'
              ? 'Set up a new team with agents and an optional team lead.'
              : 'Update the team name, members, or lead.'}
          </DialogDescription>
        </DialogHeader>

        {isEditLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div className="grid grid-cols-2 gap-6">
              {/* LEFT column — team info */}
              <div className="flex flex-col gap-4">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="team-name">Name</Label>
                  <Input
                    id="team-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Team name"
                  />
                  {isDuplicateName && (
                    <p className="text-sm text-destructive">
                      A team with this name already exists.
                    </p>
                  )}
                </div>

                <div className="flex flex-col gap-2">
                  <Label htmlFor="team-description">Description</Label>
                  <Textarea
                    id="team-description"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="Optional description"
                    rows={2}
                  />
                </div>

                <div className="flex flex-col gap-2">
                  <Label htmlFor="team-lead">Team Lead</Label>
                  <select
                    id="team-lead"
                    className={NATIVE_SELECT_CLASS}
                    value={teamLeadAgentId ?? ''}
                    onChange={(e) => {
                      setTeamLeadAgentId(e.target.value || null);
                      setFormTouched(true);
                    }}
                    disabled={selectedMemberIds.length === 0}
                  >
                    <option value="">Select a lead…</option>
                    {selectedMembers.map((agent) => (
                      <option key={agent.id} value={agent.id}>
                        {agent.name}
                      </option>
                    ))}
                  </select>
                  {formTouched && selectedMemberIds.length > 0 && !teamLeadAgentId && (
                    <p className="text-sm text-destructive">Team lead is required.</p>
                  )}
                </div>

                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <Label>Max team members</Label>
                    <span className="text-xs text-muted-foreground">{maxMembers}</span>
                  </div>
                  <Slider
                    min={2}
                    max={10}
                    step={1}
                    value={[maxMembers]}
                    onValueChange={([v]) => {
                      setMaxMembers(v);
                      if (maxConcurrentTasks > v) {
                        setMaxConcurrentTasks(v);
                      }
                    }}
                  />
                </div>

                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <Label>Max concurrent tasks</Label>
                    <span className="text-xs text-muted-foreground">{maxConcurrentTasks}</span>
                  </div>
                  <Slider
                    min={1}
                    max={maxMembers}
                    step={1}
                    value={[maxConcurrentTasks]}
                    onValueChange={([v]) => setMaxConcurrentTasks(v)}
                  />
                </div>

                <div className="flex items-center gap-2">
                  <Checkbox
                    id="allow-lead-create"
                    checked={allowTeamLeadCreateAgents}
                    onCheckedChange={(checked) => setAllowTeamLeadCreateAgents(checked === true)}
                  />
                  <Label htmlFor="allow-lead-create" className="text-sm font-normal">
                    Allow team lead to create team agents
                  </Label>
                </div>
              </div>

              {/* RIGHT column — assignments */}
              <div className="flex flex-col gap-4">
                <div className="flex flex-col gap-2">
                  <Label>Members ({selectedMemberIds.length} selected)</Label>
                  <div className="max-h-[200px] overflow-y-auto rounded-md border p-2">
                    {agents.length === 0 ? (
                      <p className="py-2 text-center text-sm text-muted-foreground">
                        No agents available
                      </p>
                    ) : (
                      agents.map((agent) => {
                        const avatarUri = getAgentAvatarDataUri(agent.name);
                        const initials = getAgentInitials(agent.name);
                        return (
                          <label
                            key={agent.id}
                            htmlFor={`member-${agent.id}`}
                            className="flex cursor-pointer items-center gap-2 rounded px-1 py-1.5 hover:bg-muted/50"
                          >
                            <Checkbox
                              id={`member-${agent.id}`}
                              checked={selectedMemberIds.includes(agent.id)}
                              onCheckedChange={(checked) =>
                                handleMemberToggle(agent.id, checked === true)
                              }
                            />
                            <Avatar className="h-6 w-6">
                              {avatarUri && <AvatarImage src={avatarUri} alt={agent.name} />}
                              <AvatarFallback className="text-xs">{initials}</AvatarFallback>
                            </Avatar>
                            <span className="text-sm">{agent.name}</span>
                          </label>
                        );
                      })
                    )}
                  </div>
                  {selectedMemberIds.length === 0 && (
                    <p className="text-sm text-muted-foreground">Select at least one member.</p>
                  )}
                </div>

                {profiles.length > 0 && (
                  <div className="flex flex-col gap-2">
                    <Label>Profiles ({selectedProfileIds.length} selected)</Label>
                    <div className="max-h-[200px] overflow-y-auto rounded-md border p-2">
                      {profiles.map((profile) => (
                        <label
                          key={profile.id}
                          htmlFor={`profile-${profile.id}`}
                          className="flex cursor-pointer items-center gap-2 rounded px-1 py-1.5 hover:bg-muted/50"
                        >
                          <Checkbox
                            id={`profile-${profile.id}`}
                            checked={selectedProfileIds.includes(profile.id)}
                            onCheckedChange={(checked) =>
                              handleProfileToggle(profile.id, checked === true)
                            }
                          />
                          <span className="text-sm">{profile.name}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                )}

                {selectedProfileIds.length > 0 && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setShowConfigModal(true)}
                  >
                    Configure allowed configs ({profileSelections.length}/
                    {selectedProfileIds.length} narrowed)
                  </Button>
                )}
              </div>
            </div>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={isSubmitting}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={!canSubmit}>
                {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {mode === 'create' ? 'Create' : 'Save'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
      <ConfigureTeamConfigsModal
        open={showConfigModal}
        onOpenChange={setShowConfigModal}
        profiles={profiles.filter((p) => selectedProfileIds.includes(p.id))}
        linkedProfileIds={selectedProfileIds}
        selections={profileSelections}
        onSave={({ profileIds, profileConfigSelections: pcs }) => {
          setSelectedProfileIds(profileIds);
          setProfileSelections(pcs);
        }}
      />
    </Dialog>
  );
}

// ── Configure Team Configs Modal ────────────────────────

interface ConfigureTeamConfigsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  profiles: Array<{ id: string; name: string }>;
  linkedProfileIds: string[];
  selections: Array<{ profileId: string; configIds: string[] }>;
  onSave: (result: {
    profileIds: string[];
    profileConfigSelections: Array<{ profileId: string; configIds: string[] }>;
  }) => void;
}

interface ProviderConfigItem {
  id: string;
  name: string;
  description: string | null;
  options: string | null;
  providerName?: string;
}

function ConfigureTeamConfigsModal({
  open,
  onOpenChange,
  profiles,
  linkedProfileIds,
  selections,
  onSave,
}: ConfigureTeamConfigsModalProps) {
  const [workingSelections, setWorkingSelections] = useState<
    Array<ProfileSelection<string, string>>
  >([]);
  const [focusedProfileId, setFocusedProfileId] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const initial: Array<ProfileSelection<string, string>> = linkedProfileIds.map((pid) => {
      const sel = selections.find((s) => s.profileId === pid);
      if (!sel || sel.configIds.length === 0) {
        return { profileKey: pid, mode: 'allow-all' as const };
      }
      return { profileKey: pid, mode: 'subset' as const, configKeys: [...sel.configIds] };
    });
    setWorkingSelections(initial);
    setFocusedProfileId(profiles.length > 0 ? profiles[0].id : null);
  }, [open, selections, profiles, linkedProfileIds]);

  const {
    data: configsData,
    isLoading: configsLoading,
    isError: configsError,
    refetch: configsRefetch,
  } = useQuery({
    queryKey: ['profileConfigs', focusedProfileId] as const,
    queryFn: () =>
      fetchJsonOrThrow<ProviderConfigItem[]>(
        `/api/profiles/${encodeURIComponent(focusedProfileId!)}/provider-configs`,
      ),
    enabled: !!focusedProfileId,
  });

  const configsByProfile = useMemo(() => {
    if (!focusedProfileId || !configsData) return {} as Record<string, ConfigItem<string>[]>;
    return {
      [focusedProfileId]: configsData.map((c) => ({
        key: c.id,
        label: c.name,
        providerName: c.providerName ?? 'unknown',
      })),
    } as Record<string, ConfigItem<string>[]>;
  }, [focusedProfileId, configsData]);

  function handleSave() {
    const profileIds: string[] = [];
    const profileConfigSelections: Array<{ profileId: string; configIds: string[] }> = [];

    for (const sel of workingSelections) {
      if (sel.mode === 'remove') continue;
      profileIds.push(sel.profileKey);
      if (sel.mode === 'subset' && sel.configKeys && sel.configKeys.length > 0) {
        profileConfigSelections.push({ profileId: sel.profileKey, configIds: sel.configKeys });
      }
    }

    onSave({ profileIds, profileConfigSelections });
    onOpenChange(false);
  }

  function getBadgeText(profileId: string): string {
    const sel = workingSelections.find((s) => s.profileKey === profileId);
    if (!sel || sel.mode === 'allow-all') return 'All';
    if (sel.mode === 'remove') return 'Removed';
    return `${sel.configKeys?.length ?? 0} selected`;
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[800px]">
        <DialogHeader>
          <DialogTitle>Configure Allowed Configs</DialogTitle>
          <DialogDescription>
            Select which providers each profile can use in this team.
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-4" style={{ minHeight: 320 }}>
          {/* Left pane: profile list */}
          <div className="w-1/3 shrink-0">
            <ScrollArea className="h-[320px] rounded-md border">
              <div className="flex flex-col p-1">
                {profiles.map((profile) => (
                  <button
                    key={profile.id}
                    type="button"
                    onClick={() => setFocusedProfileId(profile.id)}
                    className={`flex items-center justify-between rounded px-2 py-2 text-left text-sm ${
                      focusedProfileId === profile.id
                        ? 'bg-accent text-accent-foreground'
                        : 'hover:bg-muted/50'
                    }`}
                  >
                    <span className="truncate">{profile.name}</span>
                    <Badge variant="secondary" className="ml-2 shrink-0 text-xs">
                      {getBadgeText(profile.id)}
                    </Badge>
                  </button>
                ))}
              </div>
            </ScrollArea>
          </div>

          {/* Right pane: provider-grouped configs */}
          <div className="flex flex-1 flex-col gap-3">
            {configsLoading ? (
              <div className="flex flex-1 items-center justify-center">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : configsError ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-2">
                <AlertCircle className="h-5 w-5 text-destructive" />
                <p className="text-sm text-muted-foreground">Failed to load configs</p>
                <Button type="button" variant="outline" size="sm" onClick={() => configsRefetch()}>
                  Retry
                </Button>
              </div>
            ) : (
              <ScrollArea className="h-[320px]">
                <ProviderConfigGranularSelector
                  focusedProfileKey={focusedProfileId}
                  configsByProfile={configsByProfile}
                  selections={workingSelections}
                  onChange={setWorkingSelections}
                />
              </ScrollArea>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" onClick={handleSave}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Loading Skeleton ─────────────────────────────────────

function TeamCardSkeleton() {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-5 w-20" />
        </div>
        <Skeleton className="mt-2 h-4 w-full" />
      </CardHeader>
      <CardContent>
        <div className="flex items-center gap-2">
          <Skeleton className="h-6 w-6 rounded-full" />
          <Skeleton className="h-4 w-24" />
        </div>
      </CardContent>
    </Card>
  );
}

// ── Team Card ────────────────────────────────────────────

function TeamCard({
  team,
  onEdit,
  onDisband,
}: {
  team: TeamListItem;
  onEdit: () => void;
  onDisband: () => void;
}) {
  const hasAssignedLead = team.teamLeadAgentId !== null;
  const leadDisplayName = !hasAssignedLead
    ? 'No lead assigned'
    : (team.teamLeadAgentName ?? 'Unknown');
  const leadAvatarUri = team.teamLeadAgentName
    ? getAgentAvatarDataUri(team.teamLeadAgentName)
    : null;
  const leadInitials = !hasAssignedLead
    ? 'NL'
    : team.teamLeadAgentName
      ? getAgentInitials(team.teamLeadAgentName)
      : '?';

  return (
    <Card data-testid={`team-card-${team.id}`}>
      <CardHeader>
        <div className="flex items-start justify-between">
          <CardTitle className="text-lg">{team.name}</CardTitle>
          <Badge variant="secondary" className="shrink-0">
            <Users className="mr-1 h-3 w-3" />
            {team.memberCount}
          </Badge>
        </div>
        {team.description && (
          <CardDescription className="line-clamp-2">{team.description}</CardDescription>
        )}
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Crown className="h-3.5 w-3.5 shrink-0" />
            <span>Lead:</span>
            <Avatar className="h-6 w-6">
              {hasAssignedLead && leadAvatarUri && (
                <AvatarImage src={leadAvatarUri} alt={team.teamLeadAgentName ?? ''} />
              )}
              <AvatarFallback className="text-xs">{leadInitials}</AvatarFallback>
            </Avatar>
            <span className="truncate font-medium text-foreground">{leadDisplayName}</span>
          </div>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onEdit}>
              <Pencil className="h-3.5 w-3.5" />
            </Button>
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onDisband}>
              <Trash2 className="h-3.5 w-3.5 text-destructive" />
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Page Component ───────────────────────────────────────

export function TeamsPage() {
  const { selectedProjectId, selectedProject } = useSelectedProject();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  // ── Dialog state ──
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [editingTeam, setEditingTeam] = useState<TeamListItem | null>(null);
  const [disbandingTeam, setDisbandingTeam] = useState<TeamListItem | null>(null);

  // ── Queries ──
  const { data, isLoading } = useQuery({
    queryKey: teamsQueryKeys.teams(selectedProjectId ?? ''),
    queryFn: () => fetchTeams(selectedProjectId!),
    enabled: !!selectedProjectId,
  });

  const { data: agentsData } = useQuery({
    queryKey: ['teams-page-agents', selectedProjectId ?? ''] as const,
    queryFn: () => fetchProjectAgents(selectedProjectId!),
    enabled: !!selectedProjectId,
  });

  const { data: profilesData } = useQuery({
    queryKey: ['teams-page-profiles', selectedProjectId ?? ''] as const,
    queryFn: () => fetchProjectProfiles(selectedProjectId!),
    enabled: !!selectedProjectId,
  });

  const { data: editTeamDetail } = useQuery({
    queryKey: teamsQueryKeys.detail(editingTeam?.id ?? ''),
    queryFn: () => fetchTeamDetail(editingTeam!.id),
    enabled: !!editingTeam,
  });

  const teams = data?.items ?? [];
  const agents: AgentListItem[] = agentsData?.items ?? [];
  const profiles: ProfileListItem[] = profilesData?.items ?? [];
  const existingTeamNames = teams.map((t) => t.name);

  const teamDetailQueries = useQueries({
    queries: teams.map((team) => ({
      queryKey: teamsQueryKeys.detail(team.id),
      queryFn: () => fetchTeamDetail(team.id),
    })),
  });

  const agentIdsInOtherTeams = useMemo(() => {
    const ids = new Set<string>();
    teams.forEach((team, index) => {
      if (editingTeam && team.id === editingTeam.id) return;
      const detail = teamDetailQueries[index]?.data;
      if (detail?.members) {
        for (const member of detail.members) {
          ids.add(member.agentId);
        }
      }
    });
    return ids;
  }, [teamDetailQueries, teams, editingTeam]);

  const pickerAgents = useMemo(
    () => agents.filter((a) => !agentIdsInOtherTeams.has(a.id)),
    [agents, agentIdsInOtherTeams],
  );

  const editInitialData: TeamFormData | undefined = useMemo(() => {
    if (!editTeamDetail) return undefined;
    return {
      name: editTeamDetail.name,
      description: editTeamDetail.description,
      teamLeadAgentId: editTeamDetail.teamLeadAgentId,
      maxMembers: editTeamDetail.maxMembers,
      maxConcurrentTasks: editTeamDetail.maxConcurrentTasks,
      allowTeamLeadCreateAgents: editTeamDetail.allowTeamLeadCreateAgents,
      memberAgentIds: editTeamDetail.members.map((m) => m.agentId),
      profileIds: editTeamDetail.profileIds,
      profileConfigSelections: editTeamDetail.profileConfigSelections ?? [],
    };
  }, [editTeamDetail]);

  // ── Mutations ──
  const createMutation = useMutation({
    mutationFn: (payload: CreateTeamPayload) => createTeam(payload),
    onMutate: async (payload) => {
      await queryClient.cancelQueries({
        queryKey: teamsQueryKeys.teams(selectedProjectId!),
      });
      const previous = queryClient.getQueryData<ListResult<TeamListItem>>(
        teamsQueryKeys.teams(selectedProjectId!),
      );
      queryClient.setQueryData<ListResult<TeamListItem>>(
        teamsQueryKeys.teams(selectedProjectId!),
        (old) => {
          if (!old) return old;
          const optimistic: TeamListItem = {
            id: `temp-${Date.now()}`,
            projectId: selectedProjectId!,
            name: payload.name,
            description: payload.description ?? null,
            teamLeadAgentId: payload.teamLeadAgentId,
            teamLeadAgentName:
              payload.teamLeadAgentId === null
                ? null
                : (agents.find((a) => a.id === payload.teamLeadAgentId)?.name ?? null),
            maxMembers: payload.maxMembers ?? 5,
            maxConcurrentTasks: payload.maxConcurrentTasks ?? payload.maxMembers ?? 5,
            allowTeamLeadCreateAgents: payload.allowTeamLeadCreateAgents ?? false,
            memberCount: payload.memberAgentIds.length,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
          return { ...old, items: [...old.items, optimistic], total: old.total + 1 };
        },
      );
      return { previous };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: teamsQueryKeys.teams(selectedProjectId!),
      });
      toast({ title: 'Team created', description: 'Team created successfully.' });
      setShowCreateDialog(false);
    },
    onError: (_error, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(teamsQueryKeys.teams(selectedProjectId!), context.previous);
      }
      toast({ title: 'Error', description: 'Failed to create team.', variant: 'destructive' });
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: UpdateTeamPayload }) =>
      updateTeam(id, payload),
    onMutate: async ({ id, payload }) => {
      await queryClient.cancelQueries({
        queryKey: teamsQueryKeys.teams(selectedProjectId!),
      });
      const previous = queryClient.getQueryData<ListResult<TeamListItem>>(
        teamsQueryKeys.teams(selectedProjectId!),
      );
      queryClient.setQueryData<ListResult<TeamListItem>>(
        teamsQueryKeys.teams(selectedProjectId!),
        (old) => {
          if (!old) return old;
          return {
            ...old,
            items: old.items.map((t) =>
              t.id === id
                ? {
                    ...t,
                    name: payload.name ?? t.name,
                    description:
                      payload.description !== undefined
                        ? (payload.description ?? null)
                        : t.description,
                    teamLeadAgentId:
                      payload.teamLeadAgentId !== undefined
                        ? payload.teamLeadAgentId
                        : t.teamLeadAgentId,
                    teamLeadAgentName:
                      payload.teamLeadAgentId !== undefined
                        ? payload.teamLeadAgentId === null
                          ? null
                          : (agents.find((a) => a.id === payload.teamLeadAgentId)?.name ?? null)
                        : t.teamLeadAgentName,
                    memberCount: payload.memberAgentIds
                      ? payload.memberAgentIds.length
                      : t.memberCount,
                  }
                : t,
            ),
          };
        },
      );
      return { previous };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: teamsQueryKeys.teams(selectedProjectId!),
      });
      queryClient.invalidateQueries({
        queryKey: teamsQueryKeys.detail(editingTeam?.id ?? ''),
      });
      toast({ title: 'Team updated', description: 'Team updated successfully.' });
      setEditingTeam(null);
    },
    onError: (_error, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(teamsQueryKeys.teams(selectedProjectId!), context.previous);
      }
      toast({ title: 'Error', description: 'Failed to update team.', variant: 'destructive' });
    },
  });

  const disbandMutation = useMutation({
    mutationFn: disbandTeam,
    onMutate: async (teamId: string) => {
      await queryClient.cancelQueries({
        queryKey: teamsQueryKeys.teams(selectedProjectId!),
      });
      const previous = queryClient.getQueryData<ListResult<TeamListItem>>(
        teamsQueryKeys.teams(selectedProjectId!),
      );
      const teamName = previous?.items.find((t) => t.id === teamId)?.name ?? 'Team';
      queryClient.setQueryData<ListResult<TeamListItem>>(
        teamsQueryKeys.teams(selectedProjectId!),
        (old) => {
          if (!old) return old;
          return {
            ...old,
            items: old.items.filter((t) => t.id !== teamId),
            total: old.total - 1,
          };
        },
      );
      return { previous, teamName };
    },
    onSuccess: (_data, _vars, context) => {
      queryClient.invalidateQueries({
        queryKey: teamsQueryKeys.teams(selectedProjectId!),
      });
      toast({
        title: 'Team disbanded',
        description: `${context?.teamName} has been disbanded.`,
      });
    },
    onError: (_error, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(teamsQueryKeys.teams(selectedProjectId!), context.previous);
      }
      toast({ title: 'Error', description: 'Failed to disband team.', variant: 'destructive' });
    },
  });

  // ── Handlers ──
  function handleCreateSubmit(formData: TeamFormData) {
    createMutation.mutate({
      projectId: selectedProjectId!,
      name: formData.name,
      description: formData.description,
      teamLeadAgentId: formData.teamLeadAgentId,
      maxMembers: formData.maxMembers,
      maxConcurrentTasks: formData.maxConcurrentTasks,
      allowTeamLeadCreateAgents: formData.allowTeamLeadCreateAgents,
      memberAgentIds: formData.memberAgentIds,
      profileIds: formData.profileIds,
      profileConfigSelections: formData.profileConfigSelections,
    });
  }

  function handleEditSubmit(formData: TeamFormData) {
    if (!editingTeam) return;
    updateMutation.mutate({
      id: editingTeam.id,
      payload: {
        name: formData.name,
        description: formData.description,
        teamLeadAgentId: formData.teamLeadAgentId,
        maxMembers: formData.maxMembers,
        maxConcurrentTasks: formData.maxConcurrentTasks,
        allowTeamLeadCreateAgents: formData.allowTeamLeadCreateAgents,
        memberAgentIds: formData.memberAgentIds,
        profileIds: formData.profileIds,
        profileConfigSelections: formData.profileConfigSelections,
      },
    });
  }

  function handleDisbandConfirm() {
    if (disbandingTeam) {
      disbandMutation.mutate(disbandingTeam.id);
      setDisbandingTeam(null);
    }
  }

  const openCreateDialog = () => setShowCreateDialog(true);

  return (
    <div className="flex flex-col gap-6 p-6">
      <PageHeader
        title="Teams"
        description={
          selectedProject
            ? `Manage agent teams for ${selectedProject.name}`
            : 'Select a project to manage teams'
        }
        actions={
          selectedProjectId ? (
            <Button onClick={openCreateDialog}>
              <Plus className="mr-2 h-4 w-4" />
              Create Team
            </Button>
          ) : undefined
        }
      />

      {!selectedProjectId ? null : isLoading ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }, (_, i) => (
            <TeamCardSkeleton key={i} />
          ))}
        </div>
      ) : teams.length === 0 ? (
        <EmptyState
          icon={UsersRound}
          title="No teams yet"
          description="Create a team to organize your agents and coordinate their work."
          action={
            <Button onClick={openCreateDialog}>
              <Plus className="mr-2 h-4 w-4" />
              Create Team
            </Button>
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {teams.map((team) => (
            <TeamCard
              key={team.id}
              team={team}
              onEdit={() => setEditingTeam(team)}
              onDisband={() => setDisbandingTeam(team)}
            />
          ))}
        </div>
      )}

      {/* Create Dialog */}
      <TeamFormDialog
        mode="create"
        open={showCreateDialog}
        onOpenChange={setShowCreateDialog}
        onSubmit={handleCreateSubmit}
        isSubmitting={createMutation.isPending}
        agents={pickerAgents}
        agentsReady={agentsData !== undefined}
        profiles={profiles}
        existingTeamNames={existingTeamNames}
      />

      {/* Edit Dialog */}
      <TeamFormDialog
        mode="edit"
        open={!!editingTeam}
        onOpenChange={(open) => {
          if (!open) setEditingTeam(null);
        }}
        onSubmit={handleEditSubmit}
        isSubmitting={updateMutation.isPending}
        agents={pickerAgents}
        agentsReady={agentsData !== undefined}
        profiles={profiles}
        existingTeamNames={existingTeamNames}
        initialData={editInitialData}
        editTeamName={editingTeam?.name}
      />

      {/* Disband Confirm Dialog */}
      <ConfirmDialog
        open={!!disbandingTeam}
        onOpenChange={(open) => {
          if (!open) setDisbandingTeam(null);
        }}
        onConfirm={handleDisbandConfirm}
        title="Disband Team"
        description={`Are you sure you want to disband ${disbandingTeam?.name ?? 'this team'}? This will remove all team assignments.`}
        confirmText="Disband"
        variant="destructive"
        loading={disbandMutation.isPending}
      />
    </div>
  );
}

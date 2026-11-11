import { useId, useState, type ReactNode } from 'react';
import { ChevronRight, Plus, X } from 'lucide-react';
import { Button } from '@/ui/components/ui/button';
import { Checkbox } from '@/ui/components/ui/checkbox';
import { Input } from '@/ui/components/ui/input';
import { Label } from '@/ui/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/components/ui/popover';
import { ToggleGroup, ToggleGroupItem } from '@/ui/components/ui/toggle-group';
import type { StatusTone } from '@/ui/lib/status-tone';
import { StatusChip } from '@/ui/pages/cloud/StatusChip';
import {
  accessByKey,
  accessCoversFamily,
  chosenSlugs,
  projectAccessFromRows,
  type VaultEntry,
  type VaultEntryGrant,
  type VaultEntryProjectAccess,
  type VaultGivenAccess,
  type VaultGrantAccess,
  type VaultRole,
} from '@/ui/lib/vault';
import { useVaultAccess, useVaultProjectContext } from './useVaultQueries';

export interface ProjectOption {
  id: string;
  name: string;
}

export const ALL_AGENTS = 'All agents';
export const CHOSEN_ROLES = 'Chosen roles';
export const NO_AGENTS_YET = 'No agents yet. New agents with this role get it.';

/** A role by the names of its profiles. */
export function roleLabel(role: VaultRole): string {
  return role.profileNames.join(', ');
}

/** The agents a role covers now, or the text for a role with none. */
export function roleAgentsText(role: VaultRole): string {
  return role.agentNames.length > 0 ? role.agentNames.join(', ') : NO_AGENTS_YET;
}

/** Chosen role slugs that no profile of the project has now. */
export function unmatchedSlugs(slugs: string[], roles: VaultRole[]): string[] {
  return slugs.filter((slug) => !roles.some((role) => role.familySlug === slug));
}

export function unmatchedRoleLabel(slug: string): string {
  return `${slug}: no profile has this role`;
}

/** A shared entry next to a project entry with the same name: the project entry wins there. */
export function alsoHasOwnLabel(name: string): string {
  return `This project also has its own ${name}`;
}

/** A role with grants that its agents cannot use: the project's Vault access leaves it out. */
export const NO_VAULT_ACCESS = 'No Vault access';

/** The cue on an entry's project row when the project's Vault access is off. */
export function vaultOffLabel(projectName: string): string {
  return `The Vault is off in ${projectName}. Grants there stay inactive.`;
}

/** Chosen role slugs that the project's Vault access does not cover. */
export function slugsWithoutAccess(slugs: Iterable<string>, access: VaultGrantAccess): string[] {
  return [...slugs].filter((slug) => !accessCoversFamily(access, slug));
}

/** The scope of an access as a chip shows it: "All agents" or "2 roles". */
export function accessScopeLabel(access: VaultGivenAccess): string {
  if (access.mode === 'all') return ALL_AGENTS;
  const count = access.familySlugs.length;
  return `${count} ${count === 1 ? 'role' : 'roles'}`;
}

export interface AccessChip {
  key: string;
  label: string;
  tone: StatusTone;
  /** The full text when the label is short, such as an overflow count. */
  title?: string;
  /** Adds a remove button with this accessible name. */
  remove?: { label: string; onClick: () => void };
}

/** The chips of chosen roles that no profile has. Without `onRemove` they have no button. */
export function unmatchedRoleChips(
  slugs: string[],
  onRemove?: (slug: string) => void,
  removeLabel = (slug: string) => `Remove role ${slug}`,
): AccessChip[] {
  return slugs.map((slug) => ({
    key: `unmatched-${slug}`,
    label: unmatchedRoleLabel(slug),
    tone: 'warn',
    remove: onRemove && { label: removeLabel(slug), onClick: () => onRemove(slug) },
  }));
}

/** The one renderer of access chips: the entries table, the matrix and the picker use it. */
export function AccessChips({ chips, label }: { chips: AccessChip[]; label?: string }) {
  if (chips.length === 0) return null;
  return (
    <ul aria-label={label} className="flex flex-wrap gap-1.5">
      {chips.map((chip) => (
        <li key={chip.key} title={chip.title} className="inline-flex items-center gap-0.5">
          <StatusChip tone={chip.tone}>{chip.label}</StatusChip>
          {chip.remove ? (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="h-6 w-6"
              aria-label={chip.remove.label}
              onClick={chip.remove.onClick}
            >
              <X className="h-3 w-3" aria-hidden="true" />
            </Button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/**
 * The owner after save (rule A1). `currentOwner` is undefined for a create.
 * A create with one project, or an edit that names only the entry's own project,
 * gives a project entry; anything else gives a shared entry (null).
 */
function predictOwner(
  value: VaultEntryProjectAccess[],
  currentOwner: string | null | undefined,
): string | null {
  if (currentOwner === undefined) {
    return value.length === 1 ? value[0].projectId : null;
  }
  if (currentOwner !== null && value.every((item) => item.projectId === currentOwner)) {
    return currentOwner;
  }
  return null;
}

/** The owner as the UI names it: `null` is a shared entry. */
export function ownerLabel(owner: string | null, projects: ProjectOption[]): string {
  if (owner === null) return 'Shared entry';
  return `Entry of ${projects.find((project) => project.id === owner)?.name ?? owner}`;
}

/** The project list of an entry, in the order the grant rows come. */
export function accessFromGrants(grants: VaultEntryGrant[]): VaultEntryProjectAccess[] {
  return [...accessByKey(grants, (grant) => grant.projectId)].map(([projectId, access]) => ({
    projectId,
    ...access,
  }));
}

/** The API refuses "Chosen roles" with no role. */
export function isProjectAccessValid(value: VaultEntryProjectAccess[]): boolean {
  return value.every((item) => item.mode === 'all' || item.familySlugs.length > 0);
}

/**
 * The same mode and, for chosen roles, the same slugs in any order. It compares
 * structure, not a joined text key: a role slug may be any text, such as `all` or `a,b`.
 */
export function sameGrantAccess(a: VaultGrantAccess, b: VaultGrantAccess): boolean {
  if (a.mode !== b.mode) return false;
  if (a.mode !== 'families' || b.mode !== 'families') return true;
  const left = [...a.familySlugs].sort();
  const right = [...b.familySlugs].sort();
  return left.length === right.length && left.every((slug, index) => slug === right[index]);
}

/** Order-insensitive comparison of two project lists. */
export function sameProjectAccess(a: VaultEntryProjectAccess[], b: VaultEntryProjectAccess[]) {
  if (a.length !== b.length) return false;
  const byProject = new Map(b.map((item) => [item.projectId, item]));
  return a.every((item) => {
    const other = byProject.get(item.projectId);
    return other !== undefined && sameGrantAccess(item, other);
  });
}

interface ProjectAccessEditorProps {
  value: VaultEntryProjectAccess[];
  onChange: (value: VaultEntryProjectAccess[]) => void;
  projects: ProjectOption[];
  /** The entry name as it will be saved: drives the same-name warning. */
  entryName: string;
  /** The entry being edited, so it does not warn about itself. */
  entryId?: string;
  entries: VaultEntry[];
  disabled?: boolean;
  /** Opens the project on the Projects tab, the one place where Vault access is edited. */
  onOpenProjectAccess?: (projectId: string) => void;
}

export function ProjectAccessEditor({
  value,
  onChange,
  projects,
  entryName,
  entryId,
  entries,
  disabled = false,
  onOpenProjectAccess,
}: ProjectAccessEditorProps) {
  const names = new Map(projects.map((project) => [project.id, project.name]));
  // Projects added in this editing session open expanded; the rest start collapsed.
  const [addedIds, setAddedIds] = useState<ReadonlySet<string>>(new Set());
  const name = entryName.trim();
  const currentOwner = entryId
    ? (entries.find((entry) => entry.id === entryId)?.projectId ?? null)
    : undefined;
  const ownerAfterSave = predictOwner(value, currentOwner);
  const replace = (next: VaultEntryProjectAccess) =>
    onChange(value.map((item) => (item.projectId === next.projectId ? next : item)));
  const remove = (projectId: string) =>
    onChange(value.filter((item) => item.projectId !== projectId));

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">Projects</span>
        {disabled ? null : (
          <AddProjectsPopover
            projects={projects}
            selected={value.map((item) => item.projectId)}
            onToggle={(projectId, checked) => {
              if (!checked) {
                remove(projectId);
                return;
              }
              setAddedIds(new Set([...addedIds, projectId]));
              onChange([...value, { projectId, mode: 'all' }]);
            }}
          />
        )}
      </div>
      {currentOwner && ownerAfterSave === null ? (
        <p role="status" className="text-sm text-muted-foreground">
          Becomes a shared entry on save, because it names another project. A shared entry stays
          shared.
        </p>
      ) : null}
      {value.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No projects. No agent gets this entry until you add a project.
        </p>
      ) : (
        <ul className="divide-y rounded-md border">
          {value.map((item) => (
            <ProjectAccessRow
              key={item.projectId}
              access={item}
              projectName={names.get(item.projectId) ?? item.projectId}
              entryName={name}
              ownsSameName={entries.some(
                (other) =>
                  other.id !== entryId && other.projectId === item.projectId && other.name === name,
              )}
              becomesProjectEntry={ownerAfterSave === item.projectId}
              defaultOpen={addedIds.has(item.projectId)}
              disabled={disabled}
              onChange={replace}
              onRemove={() => remove(item.projectId)}
              onOpenProjectAccess={
                onOpenProjectAccess && (() => onOpenProjectAccess(item.projectId))
              }
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function AddProjectsPopover({
  projects,
  selected,
  onToggle,
}: {
  projects: ProjectOption[];
  selected: string[];
  onToggle: (projectId: string, checked: boolean) => void;
}) {
  const [search, setSearch] = useState('');
  const searchId = useId();
  const term = search.trim().toLowerCase();
  const shown = projects.filter((project) => project.name.toLowerCase().includes(term));

  return (
    <Popover onOpenChange={(open) => (open ? undefined : setSearch(''))}>
      <PopoverTrigger asChild>
        <Button type="button" size="sm" variant="outline">
          <Plus className="mr-1 h-4 w-4" aria-hidden="true" />
          Add projects
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-3" align="end">
        <div className="space-y-2">
          <Label htmlFor={searchId}>Search projects</Label>
          <Input
            id={searchId}
            value={search}
            autoComplete="off"
            className="h-8"
            onChange={(event) => setSearch(event.target.value)}
          />
          <ul className="max-h-56 space-y-0.5 overflow-y-auto" aria-label="Projects">
            {shown.length === 0 ? (
              <li className="py-2 text-sm text-muted-foreground">No project matches.</li>
            ) : (
              shown.map((project) => {
                const id = `${searchId}-${project.id}`;
                return (
                  <li
                    key={project.id}
                    className="flex items-center gap-2 rounded px-1 py-1 hover:bg-accent"
                  >
                    <Checkbox
                      id={id}
                      checked={selected.includes(project.id)}
                      onCheckedChange={(checked) => onToggle(project.id, checked === true)}
                    />
                    <Label htmlFor={id} className="flex-1 cursor-pointer truncate font-normal">
                      {project.name}
                    </Label>
                  </li>
                );
              })
            )}
          </ul>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function ProjectAccessRow({
  access,
  projectName,
  entryName,
  ownsSameName,
  becomesProjectEntry,
  defaultOpen,
  disabled,
  onChange,
  onRemove,
  onOpenProjectAccess,
}: {
  access: VaultEntryProjectAccess;
  projectName: string;
  entryName: string;
  ownsSameName: boolean;
  /** The save makes this entry a project entry of this project: a same name then conflicts. */
  becomesProjectEntry: boolean;
  /** A project added in this session opens expanded. */
  defaultOpen: boolean;
  disabled: boolean;
  onChange: (next: VaultEntryProjectAccess) => void;
  onRemove: () => void;
  onOpenProjectAccess?: () => void;
}) {
  const [open, setOpen] = useState(defaultOpen);
  // A disabled editor offers no controls, the collapse toggle included: it shows everything.
  const expanded = disabled || open;
  const { projectId } = access;
  const accessRows = useVaultAccess();
  const projectAccess = accessRows.data ? projectAccessFromRows(accessRows.data, projectId) : null;
  // An Off project gets one cue for the row, not one per role.
  const withoutAccess =
    projectAccess?.mode === 'families'
      ? slugsWithoutAccess(chosenSlugs(access), projectAccess)
      : [];
  const link = onOpenProjectAccess ? (
    <ProjectsTabLink projectName={projectName} onClick={onOpenProjectAccess} />
  ) : null;
  const sameNameLabel = becomesProjectEntry
    ? `${projectName} already has an entry named ${entryName}. Choose another name.`
    : alsoHasOwnLabel(entryName);
  // The collapsed line keeps every cue visible, so folding a row never hides a problem.
  const summaryChips: AccessChip[] = [
    { key: 'scope', tone: 'neutral', label: accessScopeLabel(access) },
    ...(projectAccess?.mode === 'none'
      ? [
          {
            key: 'off',
            tone: 'warn',
            label: 'Vault off',
            title: vaultOffLabel(projectName),
          } as const,
        ]
      : []),
    ...(withoutAccess.length > 0
      ? [{ key: 'no-access', tone: 'warn', label: NO_VAULT_ACCESS } as const]
      : []),
    ...(ownsSameName ? [{ key: 'same-name', tone: 'warn', label: sameNameLabel } as const] : []),
  ];

  return (
    <li aria-label={projectName} className="space-y-3 p-3">
      <div className="flex flex-wrap items-center gap-2">
        {disabled ? (
          <span className="min-w-0 truncate text-sm font-medium">{projectName}</span>
        ) : (
          <button
            type="button"
            className="flex min-w-0 items-center gap-2 text-left"
            aria-expanded={expanded}
            onClick={() => setOpen((current) => !current)}
          >
            <ChevronRight
              className={`h-4 w-4 shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
              aria-hidden="true"
            />
            <span className="min-w-0 truncate text-sm font-medium">{projectName}</span>
          </button>
        )}
        {expanded ? null : <AccessChips chips={summaryChips} />}
        {disabled ? null : (
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="ml-auto h-8 w-8"
            aria-label={`Remove ${projectName}`}
            onClick={onRemove}
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </Button>
        )}
      </div>
      {expanded ? (
        <AccessPicker
          projectId={projectId}
          value={access}
          onChange={(next) => onChange({ projectId, ...next })}
          modeLabel={`Access in ${projectName}`}
          leading={null}
          roleCue={(role) =>
            withoutAccess.includes(role.familySlug) ? <NoAccessMarker>{link}</NoAccessMarker> : null
          }
          disabled={disabled}
        >
          {projectAccess?.mode === 'none' ? (
            <span className="flex flex-wrap items-center gap-1">
              <StatusChip tone="warn">{vaultOffLabel(projectName)}</StatusChip>
              {link}
            </span>
          ) : null}
          {ownsSameName ? (
            <AccessChips chips={[{ key: 'same-name', tone: 'warn', label: sameNameLabel }]} />
          ) : null}
        </AccessPicker>
      ) : null}
    </li>
  );
}

/**
 * The access picker of one project: an All agents / Chosen roles toggle and, for
 * chosen roles, the role list. A `none` value shows only `leading` and `trailing`,
 * so the caller expresses it, such as with a switch.
 */
export function AccessPicker({
  projectId,
  value,
  onChange,
  modeLabel,
  leading,
  trailing,
  children,
  noRoleConsequence,
  roleCue,
  disabled,
}: {
  projectId: string;
  value: VaultGrantAccess;
  /** The picker's own controls never emit `none`. */
  onChange: (next: VaultGivenAccess) => void;
  /** The accessible name of the mode toggle. */
  modeLabel: string;
  leading: ReactNode;
  trailing?: ReactNode;
  /** Shows between the toggle row and the role list. */
  children?: ReactNode;
  noRoleConsequence?: string;
  /** Shows under a role of the role list. */
  roleCue?: (role: VaultRole) => ReactNode;
  disabled: boolean;
}) {
  const context = useVaultProjectContext(projectId);
  const roles = context.data?.roles ?? [];
  const chosen = chosenSlugs(value);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {leading}
        {value.mode === 'none' ? null : (
          <ToggleGroup
            type="single"
            size="sm"
            variant="outline"
            aria-label={modeLabel}
            value={value.mode}
            disabled={disabled}
            onValueChange={(mode) => {
              if (mode === 'all') onChange({ mode: 'all' });
              else if (mode === 'families' && value.mode !== 'families')
                onChange({ mode: 'families', familySlugs: [] });
            }}
          >
            <ToggleGroupItem value="all">{ALL_AGENTS}</ToggleGroupItem>
            <ToggleGroupItem value="families">{CHOSEN_ROLES}</ToggleGroupItem>
          </ToggleGroup>
        )}
        {trailing}
      </div>
      {children}
      {value.mode === 'families' ? (
        <RolePicker
          projectId={projectId}
          roles={roles}
          loading={context.isLoading}
          failed={Boolean(context.error)}
          profilesWithoutRole={context.data?.profilesWithoutRole ?? 0}
          noRoleConsequence={noRoleConsequence}
          chosen={chosen}
          unmatched={context.data ? unmatchedSlugs(chosen, roles) : []}
          roleCue={roleCue}
          disabled={disabled}
          onChange={(familySlugs) => onChange({ mode: 'families', familySlugs })}
        />
      ) : null}
    </div>
  );
}

function RolePicker({
  projectId,
  roles,
  loading,
  failed,
  profilesWithoutRole,
  noRoleConsequence = 'Their agents get only All-agents entries.',
  chosen,
  unmatched,
  roleCue,
  disabled,
  onChange,
}: {
  projectId: string;
  roles: VaultRole[];
  loading: boolean;
  failed: boolean;
  profilesWithoutRole: number;
  /** What happens to the agents of profiles with no role. */
  noRoleConsequence?: string;
  chosen: string[];
  unmatched: string[];
  roleCue?: (role: VaultRole) => ReactNode;
  disabled: boolean;
  onChange: (familySlugs: string[]) => void;
}) {
  const baseId = useId();
  const toggle = (slug: string, checked: boolean) =>
    onChange(checked ? [...chosen, slug] : chosen.filter((value) => value !== slug));

  if (loading) return <p className="text-sm text-muted-foreground">Loading roles…</p>;
  if (failed) return <p className="text-sm text-destructive">Roles could not be loaded.</p>;

  return (
    <div className="space-y-3">
      {roles.length === 0 ? (
        <p className="text-sm text-muted-foreground">No profile of this project has a role.</p>
      ) : (
        <ul className="space-y-2">
          {roles.map((role) => {
            const id = `${baseId}-${projectId}-${role.familySlug}`;
            return (
              <li key={role.familySlug} className="flex items-start gap-2">
                <Checkbox
                  id={id}
                  className="mt-0.5"
                  aria-describedby={`${id}-agents`}
                  checked={chosen.includes(role.familySlug)}
                  disabled={disabled}
                  onCheckedChange={(checked) => toggle(role.familySlug, checked === true)}
                />
                <div className="min-w-0 space-y-0.5">
                  <Label htmlFor={id} className="flex flex-wrap items-baseline gap-x-2 font-normal">
                    <span className="font-medium">{roleLabel(role)}</span>
                    <span className="text-xs text-muted-foreground">{role.familySlug}</span>
                  </Label>
                  <p id={`${id}-agents`} className="text-sm text-muted-foreground">
                    {roleAgentsText(role)}
                  </p>
                  {roleCue?.(role)}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <AccessChips
        label="Roles with no profile"
        chips={unmatchedRoleChips(unmatched, disabled ? undefined : (slug) => toggle(slug, false))}
      />
      {chosen.length === 0 ? (
        <p className="text-sm text-muted-foreground">Choose at least one role.</p>
      ) : null}
      {profilesWithoutRole > 0 ? (
        <p className="text-sm text-muted-foreground">
          {profilesWithoutRole === 1 ? '1 profile has' : `${profilesWithoutRole} profiles have`} no
          role. {noRoleConsequence}
        </p>
      ) : null}
    </div>
  );
}

/** Marks a role whose grants have no effect; `children` is the action. */
export function NoAccessMarker({ children }: { children?: ReactNode }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <StatusChip tone="warn">{NO_VAULT_ACCESS}</StatusChip>
      {children}
    </span>
  );
}

/** Opens the project on the Projects tab; entry editors never write Vault access. */
function ProjectsTabLink({ projectName, onClick }: { projectName: string; onClick: () => void }) {
  return (
    <Button
      type="button"
      size="sm"
      variant="link"
      className="h-6 px-1"
      aria-label={`Edit Vault access of ${projectName} on the Projects tab`}
      onClick={onClick}
    >
      Edit on the Projects tab
    </Button>
  );
}

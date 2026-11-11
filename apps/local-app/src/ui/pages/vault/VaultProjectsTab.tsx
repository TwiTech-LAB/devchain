import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useHomeQueryClient } from '@/ui/components/BackendBoundary';
import { ConfirmDialog } from '@/ui/components/shared';
import { Alert, AlertDescription } from '@/ui/components/ui/alert';
import { Button } from '@/ui/components/ui/button';
import { Checkbox } from '@/ui/components/ui/checkbox';
import { Label } from '@/ui/components/ui/label';
import { Switch } from '@/ui/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/ui/components/ui/table';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/ui/components/ui/tooltip';
import { useConfirmDialog } from '@/ui/hooks/useFormDialog';
import { useToastHelpers } from '@/ui/lib/toast-helpers';
import {
  accessByKey,
  addFamilyToAccess,
  chosenSlugs,
  projectAccessFromRows,
  setVaultProjectGrants,
  vaultQueryKeys,
  type VaultEntry,
  type VaultGrant,
  type VaultGrantAccess,
  type VaultProjectGrantChange,
  type VaultRole,
} from '@/ui/lib/vault';
import {
  ALL_AGENTS,
  AccessChips,
  AccessPicker,
  NoAccessMarker,
  alsoHasOwnLabel,
  roleAgentsText,
  roleLabel,
  sameGrantAccess,
  slugsWithoutAccess,
  unmatchedRoleChips,
  unmatchedSlugs,
  type AccessChip,
  type ProjectOption,
} from './ProjectAccessEditor';
import { FormError } from './VaultEntryDialogs';
import { useVaultAccess, useVaultProjectContext } from './useVaultQueries';

/**
 * Unsaved cells, tied to the project they were made in, so they never reach another one.
 * `remembered` keeps the roles a cell had when "All agents" was turned on, so turning it
 * off again brings them back.
 */
interface MatrixDraft {
  projectId: string;
  cells: Record<string, VaultGrantAccess>;
  remembered: Record<string, string[]>;
  /** The project's Vault access, when changed. */
  access?: VaultGrantAccess;
}

const NO_DRAFT: MatrixDraft = { projectId: '', cells: {}, remembered: {} };
const NO_ACCESS: VaultGrantAccess = { mode: 'none' };

/** Chosen roles; with no role the entry has no grant in the project. */
function familiesOrNone(familySlugs: string[]): VaultGrantAccess {
  return familySlugs.length > 0 ? { mode: 'families', familySlugs } : NO_ACCESS;
}

function agentCount(role: VaultRole): string {
  const count = role.agentNames.length;
  if (count === 0) return 'No agents';
  return count === 1 ? '1 agent' : `${count} agents`;
}

function changeCount(count: number): string {
  if (count === 0) return 'No changes';
  return count === 1 ? '1 change' : `${count} changes`;
}

/** A request to show one project; each new object is a new request. */
export interface ProjectRequest {
  projectId: string;
}

interface VaultProjectsTabProps {
  projects: ProjectOption[];
  entries: VaultEntry[];
  grants: VaultGrant[] | undefined;
  grantsLoading: boolean;
  grantsError: unknown;
  readOnly: boolean;
  /** False while the Vault is locked: a new entry needs a sealed value. */
  canAddEntry: boolean;
  onAddEntry: (projectId: string) => void;
  /** Reports unsaved changes, so leaving the tab can ask first. */
  onDirtyChange: (dirty: boolean) => void;
  /** Selects a project, such as from an entry editor's link; unsaved changes ask first. */
  request?: ProjectRequest;
  /** The project shown first: the app's selected project, before the list's first one. */
  defaultProjectId?: string;
}

export function VaultProjectsTab({
  projects,
  entries,
  grants,
  grantsLoading,
  grantsError,
  readOnly,
  canAddEntry,
  onAddEntry,
  onDirtyChange,
  request,
  defaultProjectId,
}: VaultProjectsTabProps) {
  const selectId = useId();
  const [chosenId, setChosenId] = useState<string | null>(
    request?.projectId ?? defaultProjectId ?? null,
  );
  const handledRequest = useRef(request);
  const [savedDraft, setDraft] = useState<MatrixDraft>(NO_DRAFT);
  const leaving = useConfirmDialog<string>();
  const queryClient = useHomeQueryClient();
  const { showSuccess } = useToastHelpers();

  const project = projects.find((item) => item.id === chosenId) ?? projects[0] ?? null;
  const projectId = project?.id ?? '';
  // Pin the first project shown, so a new project that sorts first does not take its place.
  useEffect(() => {
    if (chosenId === null && projects.length > 0) setChosenId(projects[0].id);
  }, [chosenId, projects]);
  // A draft made in another project (for example one that was deleted) does not apply here.
  const ownDraft = savedDraft.projectId === projectId ? savedDraft : NO_DRAFT;
  const draft = ownDraft.cells;
  const context = useVaultProjectContext(projectId, Boolean(project));
  const roles = context.data?.roles ?? [];
  const accessRows = useVaultAccess();
  const savedAccess = accessRows.data ? projectAccessFromRows(accessRows.data, projectId) : null;
  const access = ownDraft.access ?? savedAccess;
  const accessChanged = Boolean(
    ownDraft.access && savedAccess && !sameGrantAccess(ownDraft.access, savedAccess),
  );
  // The API refuses "Chosen roles" with no role.
  const accessValid = access?.mode !== 'families' || access.familySlugs.length > 0;
  const turningOff = accessChanged && access?.mode === 'none';
  const confirmOff = useConfirmDialog<true>();

  const rows = useMemo(
    () => entries.filter((entry) => entry.projectId === null || entry.projectId === projectId),
    [entries, projectId],
  );
  const saved = useMemo(
    () =>
      accessByKey(
        (grants ?? []).filter((grant) => grant.projectId === projectId),
        (grant) => grant.entryId,
      ),
    [grants, projectId],
  );
  const savedCell = (entryId: string): VaultGrantAccess => saved.get(entryId) ?? NO_ACCESS;
  const cellOf = (entryId: string) => draft[entryId] ?? savedCell(entryId);
  const changes: VaultProjectGrantChange[] = rows
    .filter((entry) => draft[entry.id] && !sameGrantAccess(draft[entry.id], savedCell(entry.id)))
    .map((entry) => ({ entryId: entry.id, ...draft[entry.id] }));
  const changeTotal = changes.length + (accessChanged ? 1 : 0);
  const dirty = changeTotal > 0;
  // Families with grants in this project that the Vault access leaves out.
  const grantedSlugs = new Set(rows.flatMap((entry) => chosenSlugs(cellOf(entry.id))));
  const withoutAccess = access ? slugsWithoutAccess(grantedSlugs, access) : [];

  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  const save = useMutation(
    {
      mutationFn: (vars: {
        projectId: string;
        access?: VaultGrantAccess;
        entries: VaultProjectGrantChange[];
      }) => setVaultProjectGrants(vars.projectId, vars.entries, vars.access),
      onSuccess: async (_result, vars) => {
        // Keep the draft until the refreshed rows are in, so no cell flips back meanwhile.
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: vaultQueryKeys.grants() }),
          queryClient.invalidateQueries({ queryKey: vaultQueryKeys.access() }),
        ]);
        setDraft(NO_DRAFT);
        const name = projects.find((item) => item.id === vars.projectId)?.name ?? vars.projectId;
        showSuccess({ title: 'Access saved', description: `Access in ${name} is saved.` });
      },
    },
    queryClient,
  );

  const switchProject = (next: string) => {
    setDraft(NO_DRAFT);
    save.reset();
    setChosenId(next);
  };
  const ownOf = (current: MatrixDraft) => (current.projectId === projectId ? current : NO_DRAFT);
  const setCell = (entryId: string, next: VaultGrantAccess) =>
    setDraft((current) => {
      const own = ownOf(current);
      const previous = own.cells[entryId] ?? savedCell(entryId);
      return {
        ...own,
        projectId,
        cells: { ...own.cells, [entryId]: next },
        remembered:
          next.mode === 'all'
            ? { ...own.remembered, [entryId]: chosenSlugs(previous) }
            : own.remembered,
      };
    });
  const setAccess = (next: VaultGrantAccess) =>
    setDraft((current) => ({ ...ownOf(current), projectId, access: next }));
  const runSave = () =>
    save.mutate({
      projectId,
      access: accessChanged ? ownDraft.access : undefined,
      entries: changes,
    });

  useEffect(() => {
    if (!request || handledRequest.current === request) return;
    handledRequest.current = request;
    if (request.projectId === projectId) return;
    if (dirty) leaving.open(request.projectId);
    else switchProject(request.projectId);
  });

  if (!project) {
    return <p className="text-sm text-muted-foreground">No projects yet.</p>;
  }

  let matrix: ReactNode = null;
  if (rows.length === 0) {
    matrix = (
      <p className="text-sm text-muted-foreground">
        {readOnly ? 'No entries in this project.' : 'No entries yet. Add an entry.'}
      </p>
    );
  } else if (context.isLoading || grantsLoading) {
    matrix = (
      <p role="status" className="text-sm text-muted-foreground">
        Loading access…
      </p>
    );
  } else if (!grantsError || grants) {
    // With a grants error and no loaded grants, the alert shows and nothing can be edited.
    matrix = (
      <TooltipProvider delayDuration={200}>
        <div className="overflow-x-auto rounded-md border">
          <Table aria-label={`Access in ${project.name}`}>
            <TableHeader>
              <TableRow className="bg-muted hover:bg-muted">
                <TableHead className="sticky left-0 z-10 min-w-56 bg-muted">Entry</TableHead>
                <TableHead className="text-center">{ALL_AGENTS}</TableHead>
                {roles.map((role) => (
                  <TableHead key={role.familySlug} className="min-w-28 text-center">
                    <RoleHeader role={role} />
                    {access && withoutAccess.includes(role.familySlug) ? (
                      <div className="pb-1">
                        <NoAccessMarker>
                          {readOnly || save.isPending ? null : (
                            <Button
                              type="button"
                              size="sm"
                              variant="link"
                              className="h-6 px-1"
                              aria-label={`Add Vault access for ${roleLabel(role)}`}
                              onClick={() => setAccess(addFamilyToAccess(access, role.familySlug))}
                            >
                              Add access
                            </Button>
                          )}
                        </NoAccessMarker>
                      </div>
                    ) : null}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((entry) => (
                <MatrixRow
                  key={entry.id}
                  entry={entry}
                  projectId={projectId}
                  projectName={project.name}
                  roles={roles}
                  rolesKnown={Boolean(context.data)}
                  access={cellOf(entry.id)}
                  rememberedSlugs={ownDraft.remembered[entry.id] ?? []}
                  ownsSameName={
                    entry.projectId === null &&
                    entries.some(
                      (other) => other.projectId === projectId && other.name === entry.name,
                    )
                  }
                  readOnly={readOnly || save.isPending}
                  onChange={(next) => setCell(entry.id, next)}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      </TooltipProvider>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <Label htmlFor={selectId}>Project</Label>
          <Select
            value={projectId}
            disabled={save.isPending}
            onValueChange={(next) => (dirty ? leaving.open(next) : switchProject(next))}
          >
            <SelectTrigger id={selectId} className="w-64">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {projects.map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  {item.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {readOnly ? null : (
          <Button
            variant="outline"
            className="ml-auto"
            disabled={!canAddEntry}
            onClick={() => onAddEntry(projectId)}
          >
            <Plus className="mr-2 h-4 w-4" aria-hidden="true" />
            Add entry
          </Button>
        )}
      </div>

      <FormError error={context.error} fallback="Roles could not be loaded." />
      <FormError error={grantsError} fallback="Grants could not be loaded." />
      <FormError error={accessRows.error} fallback="Vault access could not be loaded." />

      {access?.mode === 'none' ? (
        <Alert variant="warn" role="status" className="py-2">
          <AlertDescription>{vaultOffBanner(project.name)}</AlertDescription>
        </Alert>
      ) : null}

      {access ? (
        <ProjectVaultAccess
          projectId={projectId}
          projectName={project.name}
          access={access}
          readOnly={readOnly || save.isPending}
          onChange={setAccess}
        />
      ) : null}

      {matrix}

      {readOnly ? null : (
        <div className="sticky bottom-0 z-20 flex flex-wrap items-center gap-3 border-t bg-background py-3">
          <span aria-live="polite" className="mr-auto text-sm text-muted-foreground">
            {changeCount(changeTotal)}
          </span>
          <FormError
            error={save.error}
            fallback="Access could not be saved."
            className="basis-full sm:order-first"
          />
          <Button
            variant="outline"
            disabled={!dirty || save.isPending}
            onClick={() => {
              setDraft(NO_DRAFT);
              save.reset();
            }}
          >
            Discard
          </Button>
          <Button
            disabled={!dirty || !accessValid || save.isPending}
            onClick={() => (turningOff ? confirmOff.open(true) : runSave())}
          >
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
        </div>
      )}

      <ConfirmDialog
        open={confirmOff.isOpen}
        onOpenChange={confirmOff.onOpenChange}
        onConfirm={() => {
          confirmOff.close();
          runSave();
        }}
        title={`Turn off the Vault in ${project.name}?`}
        description={`Agents of ${project.name} lose Vault access at once: devchain vault exec and the Vault tools refuse them from the next call. The grants stay saved and work again when you turn the Vault on.`}
        confirmText="Turn off"
        variant="destructive"
      />
      <ConfirmDialog
        open={leaving.isOpen}
        onOpenChange={leaving.onOpenChange}
        onConfirm={() => {
          if (leaving.target) switchProject(leaving.target);
          leaving.close();
        }}
        title="Discard unsaved changes?"
        description={`Your changes to access in ${project.name} are not saved.`}
        confirmText="Discard"
        variant="destructive"
      />
    </div>
  );
}

function RoleHeader({ role }: { role: VaultRole }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          className="inline-flex flex-col items-center rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="font-medium text-foreground">{roleLabel(role)}</span>
          <span className="text-xs font-normal text-muted-foreground">{agentCount(role)}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">{roleAgentsText(role)}</TooltipContent>
    </Tooltip>
  );
}

function MatrixRow({
  entry,
  projectId,
  projectName,
  roles,
  rolesKnown,
  access,
  rememberedSlugs,
  ownsSameName,
  readOnly,
  onChange,
}: {
  entry: VaultEntry;
  projectId: string;
  projectName: string;
  roles: VaultRole[];
  rolesKnown: boolean;
  access: VaultGrantAccess;
  /** The roles that turning "All agents" off brings back. */
  rememberedSlugs: string[];
  ownsSameName: boolean;
  readOnly: boolean;
  onChange: (access: VaultGrantAccess) => void;
}) {
  const all = access.mode === 'all';
  const chosen = chosenSlugs(access);
  const toggleRole = (slug: string, checked: boolean) =>
    onChange(
      familiesOrNone(checked ? [...chosen, slug] : chosen.filter((value) => value !== slug)),
    );
  const chips: AccessChip[] = [
    ...(entry.projectId === projectId
      ? [{ key: 'own', tone: 'neutral' as const, label: 'Only this project' }]
      : []),
    ...(ownsSameName
      ? [{ key: 'same-name', tone: 'warn' as const, label: alsoHasOwnLabel(entry.name) }]
      : []),
    ...unmatchedRoleChips(
      rolesKnown ? unmatchedSlugs(chosen, roles) : [],
      readOnly ? undefined : (slug) => toggleRole(slug, false),
      (slug) => `Remove role ${slug} from ${entry.name}`,
    ),
  ];

  return (
    <TableRow aria-label={entry.name}>
      <TableCell className="sticky left-0 z-10 bg-background align-top">
        <div className="space-y-1.5">
          <span className="font-medium">{entry.name}</span>
          <AccessChips chips={chips} />
        </div>
      </TableCell>
      <TableCell className="text-center">
        <Checkbox
          aria-label={`${entry.name} for ${ALL_AGENTS} in ${projectName}`}
          checked={all}
          disabled={readOnly}
          onCheckedChange={(checked) =>
            onChange(checked === true ? { mode: 'all' } : familiesOrNone(rememberedSlugs))
          }
        />
      </TableCell>
      {roles.map((role) => {
        const label = roleLabel(role);
        return (
          <TableCell key={role.familySlug} className="text-center">
            <Checkbox
              aria-label={`${entry.name} for ${label} in ${projectName}`}
              checked={all || chosen.includes(role.familySlug)}
              disabled={readOnly}
              // "All agents" covers every role; the cell stays focusable so it reads as checked.
              aria-disabled={all || undefined}
              className={all ? 'cursor-not-allowed opacity-50' : undefined}
              onCheckedChange={(checked) => {
                if (!all) toggleRole(role.familySlug, checked === true);
              }}
            />
          </TableCell>
        );
      })}
    </TableRow>
  );
}

function vaultOffBanner(projectName: string): string {
  return `The Vault is off in ${projectName}. The grants below stay inactive until you turn it on.`;
}

const ACCESS_OFF_TEXT =
  'Off. No agent of this project gets Vault entries. When you turn it on, agents get Vault instructions automatically.';

function ProjectVaultAccess({
  projectId,
  projectName,
  access,
  readOnly,
  onChange,
}: {
  projectId: string;
  projectName: string;
  access: VaultGrantAccess;
  readOnly: boolean;
  onChange: (access: VaultGrantAccess) => void;
}) {
  const switchId = useId();
  let text = ACCESS_OFF_TEXT;
  if (access.mode === 'all') text = 'All agents of this project can use the Vault.';
  if (access.mode === 'families') text = 'Only agents of the chosen roles can use the Vault.';

  return (
    <section
      aria-label={`Vault access in ${projectName}`}
      className="space-y-3 rounded-md border p-3"
    >
      <AccessPicker
        projectId={projectId}
        value={access}
        onChange={onChange}
        modeLabel={`Vault access mode in ${projectName}`}
        leading={
          <>
            <Switch
              id={switchId}
              checked={access.mode !== 'none'}
              disabled={readOnly}
              aria-describedby={`${switchId}-text`}
              onCheckedChange={(checked) => onChange(checked ? { mode: 'all' } : NO_ACCESS)}
            />
            <Label htmlFor={switchId} className="mr-auto">
              Vault in {projectName}
            </Label>
          </>
        }
        noRoleConsequence="Their agents cannot use the Vault."
        disabled={readOnly}
      >
        <p id={`${switchId}-text`} className="text-sm text-muted-foreground">
          {text}
        </p>
      </AccessPicker>
    </section>
  );
}

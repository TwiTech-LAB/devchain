import { Button } from '@/ui/components/ui/button';
import { type VaultUseFamilyApproval } from '@/ui/lib/vault';
import { roleLabel, type ProjectOption } from './ProjectAccessEditor';
import { FormError } from './VaultEntryDialogs';
import {
  useRemoveVaultUseApproval,
  useVaultProjectContext,
  useVaultUseApprovals,
} from './useVaultQueries';

const NO_APPROVALS = 'No role skips the approval. Each session asks you.';

/** One project's "never ask again" rows, with the role names the grants editor shows. */
function ProjectApprovals({
  projectName,
  approvals,
  readOnly,
  removing,
  onRemove,
}: {
  projectName: string;
  approvals: VaultUseFamilyApproval[];
  readOnly: boolean;
  removing: boolean;
  onRemove: (approval: VaultUseFamilyApproval) => void;
}) {
  const context = useVaultProjectContext(approvals[0].projectId);
  const roles = context.data?.roles ?? [];
  return (
    <>
      {approvals.map((approval) => {
        const role = roles.find((item) => item.familySlug === approval.familySlug);
        const name = role ? roleLabel(role) : approval.familySlug;
        return (
          <li
            key={approval.familySlug}
            aria-label={`${projectName}: ${name}`}
            className="flex items-center gap-2 p-3"
          >
            <div className="mr-auto min-w-0 text-sm">
              <p className="truncate font-medium">{projectName}</p>
              <p className="truncate">
                {name}
                {role ? (
                  <span className="ml-2 text-xs text-muted-foreground">{approval.familySlug}</span>
                ) : null}
              </p>
            </div>
            {readOnly ? null : (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={removing}
                aria-label={`Remove the approval of ${name} in ${projectName}`}
                onClick={() => onRemove(approval)}
              >
                Remove
              </Button>
            )}
          </li>
        );
      })}
    </>
  );
}

/**
 * The roles the user chose "Never ask for this role" for. Remove takes effect at once,
 * not with Save: the next session of that role asks again.
 */
export function VaultUseApprovals({
  entryId,
  gated,
  projects,
  readOnly,
}: {
  entryId: string;
  /** The entry's saved approval flag. */
  gated: boolean;
  projects: ProjectOption[];
  readOnly: boolean;
}) {
  const approvals = useVaultUseApprovals(entryId);
  const remove = useRemoveVaultUseApproval(entryId);

  const rows = approvals.data ?? [];
  if (!gated && rows.length === 0) return null;

  const names = new Map(projects.map((project) => [project.id, project.name]));
  const byProject = new Map<string, VaultUseFamilyApproval[]>();
  for (const row of rows) {
    const group = byProject.get(row.projectId);
    if (group) group.push(row);
    else byProject.set(row.projectId, [row]);
  }

  return (
    <section aria-labelledby="vault-use-approvals" className="space-y-2">
      <h4 id="vault-use-approvals" className="text-sm font-medium">
        Roles that are not asked
      </h4>
      {readOnly || rows.length === 0 ? null : (
        <p className="text-sm text-muted-foreground">
          Remove takes effect at once, not with Save changes.
        </p>
      )}
      {approvals.error ? (
        <FormError error={approvals.error} fallback="Approvals could not be loaded." />
      ) : approvals.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading approvals…
        </p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{NO_APPROVALS}</p>
      ) : (
        <ul className="divide-y rounded-md border">
          {[...byProject].map(([projectId, projectRows]) => (
            <ProjectApprovals
              key={projectId}
              projectName={names.get(projectId) ?? projectId}
              approvals={projectRows}
              readOnly={readOnly}
              removing={remove.isPending}
              onRemove={(approval) => remove.mutate(approval)}
            />
          ))}
        </ul>
      )}
      <FormError error={remove.error} />
    </section>
  );
}

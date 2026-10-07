import { Button } from '@/ui/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/ui/components/ui/card';
import type { ProjectListRow } from './ProjectList';
import { StatusChip } from './StatusChip';
import { VM_NAME_BUTTON_CLASS } from './VmList';

export function ProjectSummary({
  rows,
  remoteNames,
  onOpenVm,
  onManageProjects,
}: {
  rows: readonly ProjectListRow[];
  remoteNames: ReadonlyMap<string, string>;
  onOpenVm: (remoteId: string) => void;
  onManageProjects: () => void;
}) {
  const onVmRows = rows
    .filter((row) => row.onVm)
    .sort((a, b) => a.project.name.localeCompare(b.project.name));

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0 pb-3">
        <CardTitle className="text-base">Projects on VMs</CardTitle>
        <Button size="sm" variant="outline" onClick={onManageProjects}>
          Manage projects
        </Button>
      </CardHeader>
      <CardContent>
        <ul aria-label="Projects on VMs" className="divide-y rounded-md border">
          {onVmRows.map(({ project, status: { remoteId, tone, label } }) => (
            <li
              key={project.id}
              className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm"
            >
              <span>{project.name}</span>
              {remoteId && (
                <button
                  type="button"
                  onClick={() => onOpenVm(remoteId)}
                  className={VM_NAME_BUTTON_CLASS}
                >
                  {remoteNames.get(remoteId) ?? remoteId}
                </button>
              )}
              <StatusChip tone={tone}>{label}</StatusChip>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

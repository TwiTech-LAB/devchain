import { OrchestratorApp } from '@/modules/orchestrator/ui/app/orchestrator-app';
import { Wrench } from 'lucide-react';
import { useRuntime } from '@/ui/hooks/useRuntime';
import { useSelectedProject } from '@/ui/hooks/useProjectSelection';

export function WorktreesPage() {
  const { dockerAvailable } = useRuntime();
  const { selectedProjectId } = useSelectedProject();

  if (!dockerAvailable) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center px-4 text-center">
        <div className="max-w-xl space-y-6 rounded-lg border bg-card p-8 shadow-sm">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-muted">
            <Wrench className="h-6 w-6 text-muted-foreground" />
          </div>
          <div className="space-y-2">
            <h1 className="text-2xl font-semibold">Docker required</h1>
            <p className="text-sm text-muted-foreground">
              Worktree management requires Docker. Install and start Docker, then restart Devchain
              to enable the full Worktrees dashboard.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return <OrchestratorApp ownerProjectId={selectedProjectId} />;
}

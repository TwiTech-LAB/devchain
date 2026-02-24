import { OrchestratorApp } from '@/modules/orchestrator/ui/app/orchestrator-app';
import { useSelectedProject } from '@/ui/hooks/useProjectSelection';

export function WorktreesPage() {
  const { selectedProjectId } = useSelectedProject();

  return <OrchestratorApp ownerProjectId={selectedProjectId} />;
}

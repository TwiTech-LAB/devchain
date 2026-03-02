import type { ProjectsPageController } from '@/ui/hooks/useProjectsPageController';
import { ProjectsTable } from './ProjectsTable';
import { ProjectsDialogs } from './ProjectsDialogs';

interface ProjectsPageViewProps {
  controller: ProjectsPageController;
}

export function ProjectsPageView({ controller }: ProjectsPageViewProps) {
  return (
    <div>
      <ProjectsTable controller={controller} />
      <ProjectsDialogs controller={controller} />
    </div>
  );
}

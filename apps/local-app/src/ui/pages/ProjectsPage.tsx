import { useProjectsPageController } from '@/ui/hooks/useProjectsPageController';
import { ProjectsPageView } from '@/ui/pages/projects/ProjectsPageView';

export function ProjectsPage() {
  const controller = useProjectsPageController();
  return <ProjectsPageView controller={controller} />;
}

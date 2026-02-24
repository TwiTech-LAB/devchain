import { render, screen } from '@testing-library/react';
import { WorktreesPage } from './WorktreesPage';
import { useSelectedProject } from '@/ui/hooks/useProjectSelection';

jest.mock('@/ui/hooks/useProjectSelection', () => ({
  useSelectedProject: jest.fn(),
}));

jest.mock('@/modules/orchestrator/ui/app/orchestrator-app', () => ({
  OrchestratorApp: ({ ownerProjectId }: { ownerProjectId?: string | null }) => (
    <div>Worktrees Dashboard {ownerProjectId && `(${ownerProjectId})`}</div>
  ),
}));

const useSelectedProjectMock = useSelectedProject as jest.MockedFunction<typeof useSelectedProject>;

describe('WorktreesPage', () => {
  beforeEach(() => {
    useSelectedProjectMock.mockReturnValue({
      selectedProjectId: 'project-1',
      selectedProject: null,
      setSelectedProjectId: jest.fn(),
      projects: [],
      projectsLoading: false,
      projectsError: false,
      refetchProjects: jest.fn().mockResolvedValue(undefined),
    });
  });

  it('renders OrchestratorApp with selected project id', () => {
    render(<WorktreesPage />);

    expect(screen.getByText('Worktrees Dashboard (project-1)')).toBeInTheDocument();
  });

  it('renders OrchestratorApp without project id when none selected', () => {
    useSelectedProjectMock.mockReturnValue({
      selectedProjectId: undefined,
      selectedProject: undefined,
      setSelectedProjectId: jest.fn(),
      projects: [],
      projectsLoading: false,
      projectsError: false,
      refetchProjects: jest.fn().mockResolvedValue(undefined),
    });

    render(<WorktreesPage />);

    expect(screen.getByText('Worktrees Dashboard')).toBeInTheDocument();
  });
});

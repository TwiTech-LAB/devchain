import { render, screen } from '@testing-library/react';
import { WorktreesPage } from './WorktreesPage';
import { useRuntime } from '@/ui/hooks/useRuntime';
import { useSelectedProject } from '@/ui/hooks/useProjectSelection';

jest.mock('@/ui/hooks/useRuntime', () => ({
  useRuntime: jest.fn(),
}));

jest.mock('@/ui/hooks/useProjectSelection', () => ({
  useSelectedProject: jest.fn(),
}));

jest.mock('@/modules/orchestrator/ui/app/orchestrator-app', () => ({
  OrchestratorApp: () => <div>Worktrees Dashboard</div>,
}));

const useRuntimeMock = useRuntime as jest.MockedFunction<typeof useRuntime>;
const useSelectedProjectMock = useSelectedProject as jest.MockedFunction<typeof useSelectedProject>;

describe('WorktreesPage capability gating', () => {
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

  it('shows Docker required message when docker is unavailable', () => {
    useRuntimeMock.mockReturnValue({
      runtimeInfo: undefined,
      runtimeLoading: false,
      isMainMode: false,
      dockerAvailable: false,
    });

    render(<WorktreesPage />);

    expect(screen.getByRole('heading', { name: 'Docker required' })).toBeInTheDocument();
    expect(screen.queryByText('Worktrees Dashboard')).not.toBeInTheDocument();
  });

  it('shows full worktrees dashboard when docker is available', () => {
    useRuntimeMock.mockReturnValue({
      runtimeInfo: undefined,
      runtimeLoading: false,
      isMainMode: true,
      dockerAvailable: true,
    });

    render(<WorktreesPage />);

    expect(screen.getByText('Worktrees Dashboard')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Docker required' })).not.toBeInTheDocument();
  });
});

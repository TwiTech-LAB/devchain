import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { SourcesPopover } from './SourcesPopover';

const toastSpy = jest.fn();
const useSelectedProjectMock = jest.fn();

const fetchSourcesMock = jest.fn();
const fetchCommunitySourcesMock = jest.fn();
const fetchLocalSourcesMock = jest.fn();
const addCommunitySourceMock = jest.fn();
const addLocalSourceMock = jest.fn();
const removeCommunitySourceMock = jest.fn();
const removeLocalSourceMock = jest.fn();
const enableSourceMock = jest.fn();
const disableSourceMock = jest.fn();
const enableSourceForProjectMock = jest.fn();
const disableSourceForProjectMock = jest.fn();

jest.mock('@/ui/hooks/use-toast', () => ({
  useToast: () => ({ toast: toastSpy }),
}));

jest.mock('@/ui/hooks/useProjectSelection', () => ({
  useSelectedProject: () => useSelectedProjectMock(),
}));

jest.mock('@/ui/components/ui/popover', () => ({
  Popover: ({ children }: { children: ReactElement }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: ReactElement }) => <>{children}</>,
  PopoverContent: ({ children }: { children: ReactElement }) => <div>{children}</div>,
}));

jest.mock('@/ui/components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: { children: ReactElement }) => <>{children}</>,
  Tooltip: ({ children }: { children: ReactElement }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactElement }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactElement }) => <>{children}</>,
}));

jest.mock('@/ui/components/shared/ConfirmDialog', () => ({
  ConfirmDialog: ({
    open,
    title,
    confirmText,
    onConfirm,
  }: {
    open: boolean;
    title: string;
    confirmText: string;
    onConfirm: () => void;
  }) =>
    open ? (
      <div>
        <p>{title}</p>
        <button type="button" onClick={onConfirm}>
          {confirmText}
        </button>
      </div>
    ) : null,
}));

jest.mock('./AddCommunitySourceDialog', () => ({
  AddCommunitySourceDialog: ({
    open,
    onSubmit,
  }: {
    open: boolean;
    onSubmit: (input: unknown) => Promise<void>;
  }) =>
    open ? (
      <button
        type="button"
        onClick={() => {
          void onSubmit({
            type: 'local',
            name: 'local-source',
            folderPath: '/tmp/local-source',
          });
        }}
      >
        Submit Local Source
      </button>
    ) : null,
}));

jest.mock('@/ui/lib/skills', () => {
  const actual = jest.requireActual('@/ui/lib/skills');
  return {
    ...actual,
    fetchSources: (...args: unknown[]) => fetchSourcesMock(...args),
    fetchCommunitySources: (...args: unknown[]) => fetchCommunitySourcesMock(...args),
    fetchLocalSources: (...args: unknown[]) => fetchLocalSourcesMock(...args),
    addCommunitySource: (...args: unknown[]) => addCommunitySourceMock(...args),
    addLocalSource: (...args: unknown[]) => addLocalSourceMock(...args),
    removeCommunitySource: (...args: unknown[]) => removeCommunitySourceMock(...args),
    removeLocalSource: (...args: unknown[]) => removeLocalSourceMock(...args),
    enableSource: (...args: unknown[]) => enableSourceMock(...args),
    disableSource: (...args: unknown[]) => disableSourceMock(...args),
    enableSourceForProject: (...args: unknown[]) => enableSourceForProjectMock(...args),
    disableSourceForProject: (...args: unknown[]) => disableSourceForProjectMock(...args),
  };
});

function renderWithQueryClient(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

describe('SourcesPopover', () => {
  beforeEach(() => {
    toastSpy.mockReset();
    fetchSourcesMock.mockReset();
    fetchCommunitySourcesMock.mockReset();
    fetchLocalSourcesMock.mockReset();
    addCommunitySourceMock.mockReset();
    addLocalSourceMock.mockReset();
    removeCommunitySourceMock.mockReset();
    removeLocalSourceMock.mockReset();
    enableSourceMock.mockReset();
    disableSourceMock.mockReset();
    enableSourceForProjectMock.mockReset();
    disableSourceForProjectMock.mockReset();

    useSelectedProjectMock.mockReturnValue({
      selectedProjectId: null,
      selectedProject: null,
    });

    fetchSourcesMock.mockResolvedValue([
      {
        name: 'openai',
        kind: 'builtin',
        enabled: true,
        repoUrl: 'https://github.com/openai/openai-cookbook',
        skillCount: 3,
      },
      {
        name: 'community-source',
        kind: 'community',
        enabled: true,
        repoUrl: 'https://github.com/acme/community-source',
        skillCount: 1,
      },
      {
        name: 'local-source',
        kind: 'local',
        enabled: true,
        repoUrl: '',
        folderPath: '/tmp/local-source',
        skillCount: 2,
      },
    ]);

    fetchCommunitySourcesMock.mockResolvedValue([
      {
        id: 'community-1',
        name: 'community-source',
        repoOwner: 'acme',
        repoName: 'community-source',
        branch: 'main',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);

    fetchLocalSourcesMock.mockResolvedValue([
      {
        id: 'local-1',
        name: 'local-source',
        folderPath: '/tmp/local-source',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);

    addLocalSourceMock.mockResolvedValue({
      id: 'local-1',
      name: 'local-source',
      folderPath: '/tmp/local-source',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    removeLocalSourceMock.mockResolvedValue(undefined);
  });

  it('renders local source in managed section and removes it', async () => {
    renderWithQueryClient(<SourcesPopover />);

    await waitFor(() => {
      expect(screen.getByText('Community & Local Sources')).toBeInTheDocument();
    });

    expect(screen.getByText('/tmp/local-source')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /remove local-source source/i }));
    fireEvent.click(screen.getByRole('button', { name: /remove source/i }));

    await waitFor(() => {
      expect(removeLocalSourceMock).toHaveBeenCalledWith('local-1');
    });
    expect(removeCommunitySourceMock).not.toHaveBeenCalled();
  });

  it('routes add-source dialog local submissions to addLocalSource', async () => {
    renderWithQueryClient(<SourcesPopover />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^add source$/i })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /^add source$/i }));
    fireEvent.click(screen.getByRole('button', { name: /submit local source/i }));

    await waitFor(() => {
      expect(addLocalSourceMock).toHaveBeenCalledWith({
        name: 'local-source',
        folderPath: '/tmp/local-source',
      });
    });

    expect(toastSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Local source added',
      }),
    );
  });
});

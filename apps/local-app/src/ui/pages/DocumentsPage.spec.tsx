import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DocumentsPage } from './DocumentsPage';

const useSelectedProjectMock = jest.fn();
const toastSpy = jest.fn();

jest.mock('@/ui/hooks/useProjectSelection', () => ({
  useSelectedProject: () => useSelectedProjectMock(),
}));

jest.mock('@/ui/hooks/use-toast', () => ({
  useToast: () => ({ toast: toastSpy }),
}));

jest.mock('@/ui/components/shared/ConfirmDialog', () => ({
  ConfirmDialog: ({
    open,
    title,
    description,
    onConfirm,
    onOpenChange,
    confirmText,
    cancelText,
  }: {
    open: boolean;
    title: string;
    description: string;
    onConfirm: () => void;
    onOpenChange: (open: boolean) => void;
    confirmText: string;
    cancelText: string;
  }) =>
    open ? (
      <div data-testid="confirm-dialog">
        <p>{title}</p>
        <p>{description}</p>
        <button
          type="button"
          data-testid="confirm-dialog-cancel"
          onClick={() => onOpenChange(false)}
        >
          {cancelText}
        </button>
        <button type="button" data-testid="confirm-dialog-confirm" onClick={onConfirm}>
          {confirmText}
        </button>
      </div>
    ) : null,
}));

jest.mock('@/ui/components/ContextualSidebar', () => ({
  ContextualSidebar: ({
    savedViews,
    facets,
  }: {
    savedViews: React.ReactNode;
    facets: React.ReactNode;
  }) => (
    <div>
      <div>{savedViews}</div>
      <div>{facets}</div>
    </div>
  ),
  useContextualSidebar: () => ({
    mobileOpen: false,
    setMobileOpen: jest.fn(),
  }),
}));

jest.mock('@/ui/components/FacetedNav', () => ({
  FacetedNav: () => <div data-testid="faceted-nav" />,
}));

jest.mock('@/ui/components/InlineTagInput', () => ({
  InlineTagInput: () => <div data-testid="inline-tag-input" />,
}));

jest.mock('@/ui/components/DocumentPreviewPane', () => ({
  DocumentPreviewPane: () => <div data-testid="document-preview-pane" />,
}));

jest.mock('@/ui/components/ui/select', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const React = require('react');
  let currentTriggerId: string | undefined;

  interface SelectTriggerProps {
    id?: string;
    children: React.ReactNode;
  }

  interface SelectContentProps {
    children: React.ReactNode;
  }

  interface SelectItemProps {
    value: string;
    children: React.ReactNode;
  }

  interface SelectProps {
    value: string;
    onValueChange?: (value: string) => void;
    children: React.ReactNode;
  }

  interface SelectValueProps {
    placeholder?: string;
  }

  const SelectTrigger = ({ id, children }: SelectTriggerProps) => {
    currentTriggerId = id;
    return <>{children}</>;
  };

  const SelectContent = ({ children }: SelectContentProps) => <>{children}</>;

  const SelectItem = ({ value, children }: SelectItemProps) => (
    <option value={value}>{children}</option>
  );
  (SelectItem as { __SELECT_ITEM?: boolean }).__SELECT_ITEM = true;

  const collectOptions = (nodes: React.ReactNode): React.ReactNode[] => {
    const options: React.ReactNode[] = [];
    React.Children.forEach(nodes, (child: React.ReactElement) => {
      if (!child) return;
      if (child.type === SelectTrigger && child.props?.id) {
        currentTriggerId = child.props.id;
      }
      if (child.type === SelectContent) {
        options.push(...collectOptions(child.props.children));
      } else if (child.type && (child.type as { __SELECT_ITEM?: boolean }).__SELECT_ITEM) {
        options.push(
          <option key={child.props.value} value={child.props.value}>
            {child.props.children}
          </option>,
        );
      }
    });
    return options;
  };

  const Select = ({ value, onValueChange, children }: SelectProps) => {
    const options = collectOptions(children);
    const element = (
      <select
        id={currentTriggerId}
        value={value}
        onChange={(event) => onValueChange?.(event.target.value)}
      >
        {options}
      </select>
    );
    currentTriggerId = undefined;
    return element;
  };

  const SelectValue = ({ placeholder }: SelectValueProps) => <>{placeholder}</>;

  return { Select, SelectTrigger, SelectContent, SelectItem, SelectValue };
});

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );

  return { Wrapper };
}

describe('DocumentsPage confirm migrations', () => {
  const originalFetch = global.fetch;
  const fetchMock = jest.fn();
  let confirmSpy: jest.SpyInstance;

  beforeEach(() => {
    useSelectedProjectMock.mockReturnValue({
      selectedProjectId: 'project-1',
      selectedProject: { id: 'project-1', name: 'Demo Project' },
      projects: [{ id: 'project-1', name: 'Demo Project' }],
      projectsLoading: false,
      projectsError: false,
      setSelectedProjectId: jest.fn(),
      refetchProjects: jest.fn(),
    });

    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.startsWith('/api/documents?')) {
        return {
          ok: true,
          json: async () => ({
            items: [
              {
                id: 'doc-1',
                projectId: 'project-1',
                title: 'Runbook',
                slug: 'runbook',
                contentMd: '# Runbook',
                archived: false,
                version: 1,
                tags: ['ops'],
                createdAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-01-02T00:00:00.000Z',
              },
            ],
            total: 1,
            limit: 10,
            offset: 0,
          }),
        } as Response;
      }

      if (url === '/api/documents/doc-1' && init?.method === 'DELETE') {
        return {
          ok: true,
          json: async () => ({}),
        } as Response;
      }

      return {
        ok: true,
        json: async () => ({}),
      } as Response;
    });

    global.fetch = fetchMock as unknown as typeof fetch;
    localStorage.clear();
    localStorage.setItem(
      'devchain:docViews:project-1',
      JSON.stringify([{ id: 'view-1', name: 'Critical docs', tags: [], q: '' }]),
    );
    confirmSpy = jest.spyOn(window, 'confirm');
  });

  afterEach(() => {
    global.fetch = originalFetch;
    fetchMock.mockReset();
    toastSpy.mockReset();
    confirmSpy.mockRestore();
  });

  it('opens themed confirm for document delete and only deletes on confirm', async () => {
    const { Wrapper } = createWrapper();
    const { container } = render(
      <Wrapper>
        <DocumentsPage />
      </Wrapper>,
    );

    await screen.findByText('Runbook');

    const deleteButton = container.querySelector('button[title="Delete"]');
    expect(deleteButton).not.toBeNull();

    await act(async () => {
      fireEvent.click(deleteButton as HTMLButtonElement);
    });

    expect(screen.getByText('Delete document?')).toBeInTheDocument();
    expect(confirmSpy).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByTestId('confirm-dialog-cancel'));
    });

    expect(fetchMock).not.toHaveBeenCalledWith('/api/documents/doc-1', { method: 'DELETE' });

    await act(async () => {
      fireEvent.click(deleteButton as HTMLButtonElement);
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));
    });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/documents/doc-1', { method: 'DELETE' });
    });
  });

  it('replaces saved-view deletion confirm with themed dialog and preserves delete behavior', async () => {
    const { Wrapper } = createWrapper();
    render(
      <Wrapper>
        <DocumentsPage />
      </Wrapper>,
    );

    const select = await screen.findByRole('combobox');
    await act(async () => {
      fireEvent.change(select, { target: { value: 'view-1' } });
    });

    const deleteButtons = screen.getAllByRole('button', { name: /^delete$/i });
    await act(async () => {
      fireEvent.click(deleteButtons[0]);
    });

    expect(screen.getByText('Delete saved view?')).toBeInTheDocument();
    expect(screen.getByText('Delete view "Critical docs"?')).toBeInTheDocument();
    expect(confirmSpy).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));
    });

    await waitFor(() => {
      expect(screen.queryByRole('option', { name: 'Critical docs' })).not.toBeInTheDocument();
    });
    expect(toastSpy).toHaveBeenCalledWith({
      title: 'View deleted',
      description: '"Critical docs" removed.',
    });
  });
});

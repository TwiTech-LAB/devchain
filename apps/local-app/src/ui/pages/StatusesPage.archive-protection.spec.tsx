import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Import as ComponentType to avoid strict JSX component typing complaints
// eslint-disable-next-line @typescript-eslint/no-var-requires
const StatusesPage: React.ComponentType = require('./StatusesPage').StatusesPage;

// Mock project selection to provide a selected project
jest.mock('@/ui/hooks/useProjectSelection', () => ({
  useSelectedProject: () => ({
    projects: [],
    projectsLoading: false,
    projectsError: false,
    refetchProjects: jest.fn(),
    selectedProjectId: 'project-1',
    selectedProject: { id: 'project-1', name: 'Project Alpha' },
    setSelectedProjectId: jest.fn(),
  }),
}));

// JSDOM lacks ResizeObserver used by Radix
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(global as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

function Wrapper({ children }: { children: React.ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </MemoryRouter>
  );
}

describe('StatusesPage — Archive status protection', () => {
  const originalFetch = global.fetch;
  let fetchMock: jest.Mock;

  const mockStatuses = [
    {
      id: 's1',
      projectId: 'project-1',
      label: 'Todo',
      color: '#aaa',
      position: 0,
      mcpHidden: false,
      epicCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    {
      id: 's2',
      projectId: 'project-1',
      label: 'Archive',
      color: '#888',
      position: 1,
      mcpHidden: false,
      epicCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    {
      id: 's3',
      projectId: 'project-1',
      label: 'Review',
      color: '#0af',
      position: 2,
      mcpHidden: false,
      epicCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ];

  beforeEach(() => {
    fetchMock = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/statuses')) {
        return {
          ok: true,
          json: async () => ({ items: mockStatuses }),
        } as Response;
      }
      if (url.startsWith('/api/settings')) {
        return {
          ok: true,
          json: async () => ({ autoClean: { statusIds: {} } }),
        } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    }) as jest.Mock;
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    if (originalFetch) {
      global.fetch = originalFetch;
    }
  });

  it('disables delete button for Archive status and shows tooltip', async () => {
    render(
      <Wrapper>
        <StatusesPage />
      </Wrapper>,
    );

    // Wait for statuses to load
    await waitFor(() => {
      expect(screen.getByText('Archive')).toBeInTheDocument();
    });

    // Find all delete buttons - Archive status should have a disabled one
    const archiveRow = screen.getByText('Archive').closest('[draggable]');
    expect(archiveRow).toBeInTheDocument();

    // The Archive row should have a disabled delete button
    const deleteButton = archiveRow!.querySelector('button[disabled][aria-label*="Delete"]');
    expect(deleteButton).toBeInTheDocument();
    expect(deleteButton).toBeDisabled();
  });

  it('allows delete button for non-archive statuses (Review)', async () => {
    render(
      <Wrapper>
        <StatusesPage />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(screen.getByText('Review')).toBeInTheDocument();
    });

    // Find the Review row
    const reviewRow = screen.getByText('Review').closest('[draggable]');
    expect(reviewRow).toBeInTheDocument();

    // The Review row should have an enabled delete button
    const deleteButton = reviewRow!.querySelector('button[aria-label="Delete"]');
    expect(deleteButton).toBeInTheDocument();
    expect(deleteButton).not.toBeDisabled();
  });

  it('shows validation error when renaming Archive to remove "archiv" keyword', async () => {
    render(
      <Wrapper>
        <StatusesPage />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(screen.getByText('Archive')).toBeInTheDocument();
    });

    // Find and click the edit button for Archive status
    const archiveRow = screen.getByText('Archive').closest('[draggable]');
    const editButton = archiveRow!.querySelector('button[aria-label="Edit"]');
    expect(editButton).toBeInTheDocument();
    fireEvent.click(editButton!);

    // Wait for dialog to open
    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    // Find the label input and change it to "Done"
    const labelInput = screen.getByLabelText('Label *');
    fireEvent.change(labelInput, { target: { value: 'Done' } });

    // Should show validation error
    await waitFor(() => {
      expect(
        screen.getByText("Label must contain 'Archive' for filtering to work"),
      ).toBeInTheDocument();
    });

    // Update button should be disabled
    const updateButton = screen.getByRole('button', { name: 'Update' });
    expect(updateButton).toBeDisabled();
  });

  it('allows renaming Archive to "Archived Items" (still contains archiv)', async () => {
    render(
      <Wrapper>
        <StatusesPage />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(screen.getByText('Archive')).toBeInTheDocument();
    });

    // Find and click the edit button for Archive status
    const archiveRow = screen.getByText('Archive').closest('[draggable]');
    const editButton = archiveRow!.querySelector('button[aria-label="Edit"]');
    fireEvent.click(editButton!);

    // Wait for dialog to open
    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    // Find the label input and change it to "Archived Items"
    const labelInput = screen.getByLabelText('Label *');
    fireEvent.change(labelInput, { target: { value: 'Archived Items' } });

    // Should NOT show validation error
    await waitFor(() => {
      expect(
        screen.queryByText("Label must contain 'Archive' for filtering to work"),
      ).not.toBeInTheDocument();
    });

    // Update button should be enabled
    const updateButton = screen.getByRole('button', { name: 'Update' });
    expect(updateButton).not.toBeDisabled();
  });

  it('allows renaming non-archive status (Review) freely', async () => {
    render(
      <Wrapper>
        <StatusesPage />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(screen.getByText('Review')).toBeInTheDocument();
    });

    // Find and click the edit button for Review status
    const reviewRow = screen.getByText('Review').closest('[draggable]');
    const editButton = reviewRow!.querySelector('button[aria-label="Edit"]');
    fireEvent.click(editButton!);

    // Wait for dialog to open
    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    // Find the label input and change it to "Code Review"
    const labelInput = screen.getByLabelText('Label *');
    fireEvent.change(labelInput, { target: { value: 'Code Review' } });

    // Should NOT show validation error
    await waitFor(() => {
      expect(
        screen.queryByText("Label must contain 'Archive' for filtering to work"),
      ).not.toBeInTheDocument();
    });

    // Update button should be enabled
    const updateButton = screen.getByRole('button', { name: 'Update' });
    expect(updateButton).not.toBeDisabled();
  });
});

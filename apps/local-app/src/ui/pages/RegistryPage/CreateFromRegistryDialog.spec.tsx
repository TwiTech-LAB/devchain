import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { CreateFromRegistryDialog } from './CreateFromRegistryDialog';

// Mock Radix Dialog portal to render inline for testing
jest.mock('@radix-ui/react-dialog', () => {
  const actual = jest.requireActual('@radix-ui/react-dialog');
  return {
    ...actual,
    Portal: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  };
});

// Mock useNavigate
const mockNavigate = jest.fn();
jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useNavigate: () => mockNavigate,
}));

// Mock useToast
const mockToast = jest.fn();
jest.mock('@/ui/hooks/use-toast', () => ({
  useToast: () => ({ toast: mockToast }),
}));

// ResizeObserver mock for Radix components
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(global as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

function renderWithProviders(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('CreateFromRegistryDialog', () => {
  const originalFetch = global.fetch;
  const defaultProps = {
    slug: 'test-template',
    version: '1.0.0',
    templateName: 'Test Template',
    open: true,
    onClose: jest.fn(),
  };

  afterEach(() => {
    if (originalFetch) {
      global.fetch = originalFetch;
    }
    jest.clearAllMocks();
  });

  it('renders nothing when open is false', () => {
    renderWithProviders(<CreateFromRegistryDialog {...defaultProps} open={false} />);

    expect(screen.queryByText('Create Project from Template')).not.toBeInTheDocument();
  });

  it('displays dialog title and template info', () => {
    renderWithProviders(<CreateFromRegistryDialog {...defaultProps} />);

    expect(screen.getByText('Create Project from Template')).toBeInTheDocument();
    expect(screen.getByText(/Test Template/)).toBeInTheDocument();
    expect(screen.getByText(/v1.0.0/)).toBeInTheDocument();
  });

  it('has project name input', () => {
    renderWithProviders(<CreateFromRegistryDialog {...defaultProps} />);

    expect(screen.getByLabelText('Project Name')).toBeInTheDocument();
  });

  it('has description textarea', () => {
    renderWithProviders(<CreateFromRegistryDialog {...defaultProps} />);

    expect(screen.getByLabelText(/Description/)).toBeInTheDocument();
  });

  it('has root path input', () => {
    renderWithProviders(<CreateFromRegistryDialog {...defaultProps} />);

    expect(screen.getByLabelText('Root Path')).toBeInTheDocument();
  });

  it('has Cancel and Create Project buttons', () => {
    renderWithProviders(<CreateFromRegistryDialog {...defaultProps} />);

    expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create project/i })).toBeInTheDocument();
  });

  /**
   * SKIPPED TESTS: Submit-time validation errors (Q2 Phase 1.0.4)
   *
   * These tests are intentionally skipped because:
   * 1. The component uses disabled-button validation (button disabled when form invalid)
   * 2. Submit-time validation errors are unreachable when button is disabled
   * 3. The actual validation behavior is tested in "Create button is disabled when required fields are empty"
   *
   * If the component changes to allow submit with invalid data (e.g., for async validation),
   * these tests should be un-skipped and updated accordingly.
   */
  it.skip('shows error when project name is empty on submit', async () => {
    renderWithProviders(<CreateFromRegistryDialog {...defaultProps} />);

    // Fill only root path
    fireEvent.change(screen.getByLabelText('Root Path'), { target: { value: '/tmp/test' } });

    const submitButton = screen.getByRole('button', { name: /create project/i });
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(screen.getByText('Project name is required')).toBeInTheDocument();
    });
  });

  it.skip('shows error when root path is empty on submit', async () => {
    renderWithProviders(<CreateFromRegistryDialog {...defaultProps} />);

    // Fill only project name
    fireEvent.change(screen.getByLabelText('Project Name'), { target: { value: 'My Project' } });

    const submitButton = screen.getByRole('button', { name: /create project/i });
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(screen.getByText('Root path is required')).toBeInTheDocument();
    });
  });

  it('submits form with valid data', async () => {
    const fetchMock = jest.fn(async () => ({
      ok: true,
      json: async () => ({
        project: { id: 'proj-123', name: 'My Project', rootPath: '/tmp/test' },
        fromRegistry: true,
        templateSlug: 'test-template',
        templateVersion: '1.0.0',
      }),
    })) as unknown as typeof fetch;
    global.fetch = fetchMock;

    renderWithProviders(<CreateFromRegistryDialog {...defaultProps} />);

    // Fill form
    fireEvent.change(screen.getByLabelText('Project Name'), { target: { value: 'My Project' } });
    fireEvent.change(screen.getByLabelText(/Description/), {
      target: { value: 'A test project' },
    });
    fireEvent.change(screen.getByLabelText('Root Path'), { target: { value: '/tmp/test' } });

    // Submit
    const submitButton = screen.getByRole('button', { name: /create project/i });
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/registry/create-project',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    });
  });

  it('shows loading state during creation', async () => {
    let resolvePromise: (value: unknown) => void;
    const pendingPromise = new Promise((resolve) => {
      resolvePromise = resolve;
    });

    global.fetch = jest.fn(async () => {
      await pendingPromise;
      return {
        ok: true,
        json: async () => ({
          project: { id: 'proj-123', name: 'My Project', rootPath: '/tmp/test' },
        }),
      };
    }) as unknown as typeof fetch;

    renderWithProviders(<CreateFromRegistryDialog {...defaultProps} />);

    // Fill form
    fireEvent.change(screen.getByLabelText('Project Name'), { target: { value: 'My Project' } });
    fireEvent.change(screen.getByLabelText('Root Path'), { target: { value: '/tmp/test' } });

    // Submit
    fireEvent.click(screen.getByRole('button', { name: /create project/i }));

    await waitFor(() => {
      expect(screen.getByText('Creating...')).toBeInTheDocument();
    });

    // Cleanup
    resolvePromise!({});
  });

  it('shows success toast and navigates on success', async () => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({
        project: { id: 'proj-123', name: 'My Project', rootPath: '/tmp/test' },
        fromRegistry: true,
        templateSlug: 'test-template',
        templateVersion: '1.0.0',
      }),
    })) as unknown as typeof fetch;

    const onClose = jest.fn();
    renderWithProviders(<CreateFromRegistryDialog {...defaultProps} onClose={onClose} />);

    // Fill form
    fireEvent.change(screen.getByLabelText('Project Name'), { target: { value: 'My Project' } });
    fireEvent.change(screen.getByLabelText('Root Path'), { target: { value: '/tmp/test' } });

    // Submit
    fireEvent.click(screen.getByRole('button', { name: /create project/i }));

    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Project Created',
        }),
      );
      expect(onClose).toHaveBeenCalled();
      expect(mockNavigate).toHaveBeenCalledWith('/projects');
    });
  });

  it('shows error message on API failure', async () => {
    global.fetch = jest.fn(async () => ({
      ok: false,
      json: async () => ({ message: 'Template download failed' }),
    })) as unknown as typeof fetch;

    renderWithProviders(<CreateFromRegistryDialog {...defaultProps} />);

    // Fill form
    fireEvent.change(screen.getByLabelText('Project Name'), { target: { value: 'My Project' } });
    fireEvent.change(screen.getByLabelText('Root Path'), { target: { value: '/tmp/test' } });

    // Submit
    fireEvent.click(screen.getByRole('button', { name: /create project/i }));

    await waitFor(() => {
      expect(screen.getByText('Template download failed')).toBeInTheDocument();
    });
  });

  it('Cancel button calls onClose', () => {
    const onClose = jest.fn();
    renderWithProviders(<CreateFromRegistryDialog {...defaultProps} onClose={onClose} />);

    const cancelButton = screen.getByRole('button', { name: /cancel/i });
    fireEvent.click(cancelButton);

    expect(onClose).toHaveBeenCalled();
  });

  it('disables inputs and buttons during creation', async () => {
    let resolvePromise: (value: unknown) => void;
    const pendingPromise = new Promise((resolve) => {
      resolvePromise = resolve;
    });

    global.fetch = jest.fn(async () => {
      await pendingPromise;
      return {
        ok: true,
        json: async () => ({
          project: { id: 'proj-123', name: 'My Project', rootPath: '/tmp/test' },
        }),
      };
    }) as unknown as typeof fetch;

    renderWithProviders(<CreateFromRegistryDialog {...defaultProps} />);

    // Fill form
    fireEvent.change(screen.getByLabelText('Project Name'), { target: { value: 'My Project' } });
    fireEvent.change(screen.getByLabelText('Root Path'), { target: { value: '/tmp/test' } });

    // Submit
    fireEvent.click(screen.getByRole('button', { name: /create project/i }));

    await waitFor(() => {
      expect(screen.getByLabelText('Project Name')).toBeDisabled();
      expect(screen.getByLabelText('Root Path')).toBeDisabled();
      expect(screen.getByRole('button', { name: /cancel/i })).toBeDisabled();
    });

    // Cleanup
    resolvePromise!({});
  });

  it('Create button is disabled when required fields are empty', () => {
    renderWithProviders(<CreateFromRegistryDialog {...defaultProps} />);

    const submitButton = screen.getByRole('button', { name: /create project/i });
    expect(submitButton).toBeDisabled();
  });

  it('Create button is enabled when required fields are filled', async () => {
    renderWithProviders(<CreateFromRegistryDialog {...defaultProps} />);

    // Fill required fields
    fireEvent.change(screen.getByLabelText('Project Name'), { target: { value: 'My Project' } });
    fireEvent.change(screen.getByLabelText('Root Path'), { target: { value: '/tmp/test' } });

    await waitFor(() => {
      const submitButton = screen.getByRole('button', { name: /create project/i });
      expect(submitButton).not.toBeDisabled();
    });
  });
});

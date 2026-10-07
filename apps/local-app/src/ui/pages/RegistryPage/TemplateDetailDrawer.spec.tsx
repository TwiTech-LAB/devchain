import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { TemplateDetailDrawer } from './TemplateDetailDrawer';

// Mock Radix Dialog portal to render inline for testing
jest.mock('@radix-ui/react-dialog', () => {
  const actual = jest.requireActual('@radix-ui/react-dialog');
  return {
    ...actual,
    Portal: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  };
});

// ResizeObserver mock for Radix components
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(global as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

function renderWithProviders(ui: React.ReactElement, seedProjects = false) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
  if (seedProjects) {
    queryClient.setQueryData(['registry-template', 'test-template'], mockTemplateDetail);
    queryClient.setQueryData(['registry-projects-using', 'test-template'], mockProjectsUsing);
  }
  return render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>
    </MemoryRouter>,
  );
}

const mockTemplateDetail = {
  template: {
    slug: 'test-template',
    name: 'Test Template',
    description: 'A test template for unit testing',
    authorName: 'Test Author',
    license: 'MIT',
    category: 'development',
    tags: ['test', 'example'],
    requiredProviders: ['openai', 'anthropic'],
    isOfficial: true,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-15T00:00:00Z',
  },
  versions: [
    {
      version: '2.0.0',
      minDevchainVersion: '0.5.0',
      changelog: 'Major update with new features',
      publishedAt: '2024-01-15T00:00:00Z',
      downloadCount: 50,
      isLatest: true,
    },
    {
      version: '1.0.0',
      minDevchainVersion: '0.3.0',
      changelog: 'Initial release',
      publishedAt: '2024-01-01T00:00:00Z',
      downloadCount: 100,
      isLatest: false,
    },
  ],
};

const mockProjectsUsing = {
  projects: [
    {
      projectId: 'project-12345678-abcd',
      projectName: 'My Test Project',
      installedVersion: '1.0.0',
      installedAt: '2024-01-05T00:00:00Z',
      lastUpdateCheckAt: '2024-01-10T00:00:00Z',
    },
  ],
};

describe('TemplateDetailDrawer', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    if (originalFetch) {
      global.fetch = originalFetch;
    }
    jest.clearAllMocks();
  });

  it('renders nothing when slug is undefined', () => {
    global.fetch = jest.fn() as unknown as typeof fetch;
    renderWithProviders(<TemplateDetailDrawer slug={undefined} onClose={jest.fn()} />);

    expect(screen.queryByText('Test Template')).not.toBeInTheDocument();
  });

  it('displays template name and description', async () => {
    const onClose = jest.fn();

    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/registry/templates/test-template')) {
        return { ok: true, json: async () => mockTemplateDetail };
      }
      if (url.includes('/api/registry/projects/test-template')) {
        return { ok: true, json: async () => ({ projects: [] }) };
      }
      return { ok: true, json: async () => ({}) };
    }) as unknown as typeof fetch;

    renderWithProviders(<TemplateDetailDrawer slug="test-template" onClose={onClose} />);

    await waitFor(() => {
      expect(screen.getByText('Test Template')).toBeInTheDocument();
      expect(screen.getByText('A test template for unit testing')).toBeInTheDocument();
    });

    {
      await waitFor(() => {
        expect(screen.getByText('Official')).toBeInTheDocument();
      });
    }
    {
      await waitFor(() => {
        expect(screen.getByText('Test Author')).toBeInTheDocument();
        // License field is intentionally hidden from UI (kept in API/types)
        expect(screen.queryByText('MIT')).not.toBeInTheDocument();
        expect(screen.getByText('development')).toBeInTheDocument();
      });
    }
    {
      await waitFor(() => {
        expect(screen.getByText('test')).toBeInTheDocument();
        expect(screen.getByText('example')).toBeInTheDocument();
      });
    }
    {
      await waitFor(() => {
        expect(screen.getByText('openai')).toBeInTheDocument();
        expect(screen.getByText('anthropic')).toBeInTheDocument();
      });
    }
    {
      await waitFor(() => {
        expect(screen.getByText('Versions')).toBeInTheDocument();
      });
    }
    {
      await waitFor(() => {
        expect(screen.getByText('Test Template')).toBeInTheDocument();
      });
      expect(screen.getByRole('button', { name: /create new project/i })).toBeInTheDocument();
    }
    {
      await waitFor(() => {
        expect(screen.getByText('Test Template')).toBeInTheDocument();
      });
      const closeButtons = screen.getAllByRole('button', { name: /close/i });
      const closeButton = closeButtons.find((btn) => btn.textContent === 'Close');
      expect(closeButton).toBeDefined();
      fireEvent.click(closeButton!);
      expect(onClose).toHaveBeenCalled();
    }
  });

  it('displays projects using template with update badge', async () => {
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/registry/templates/')) {
        return { ok: true, json: async () => mockTemplateDetail };
      }
      if (url.includes('/api/registry/projects/')) {
        return { ok: true, json: async () => mockProjectsUsing };
      }
      return { ok: true, json: async () => ({}) };
    }) as unknown as typeof fetch;

    renderWithProviders(<TemplateDetailDrawer slug="test-template" onClose={jest.fn()} />, true);

    const installed = await screen.findByRole('button', { name: /Installed In/ });
    fireEvent.click(installed);
    const project = await screen.findByText('My Test Project');
    const row = project.closest('[title]')!;
    expect(within(row as HTMLElement).getByText('v1.0.0')).toBeInTheDocument();
    expect(within(row as HTMLElement).getByText('Update')).toBeInTheDocument();
  });

  it.each([
    { status: 500, slug: 'test-template', message: 'Failed to load template details' },
    { status: 404, slug: 'non-existent', message: 'Template not found' },
  ])('shows $message for HTTP $status', async ({ status, slug, message }) => {
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/registry/templates/')) {
        return { ok: false, status };
      }
      if (url.includes('/api/registry/projects/')) {
        return { ok: true, json: async () => ({ projects: [] }) };
      }
      return { ok: true, json: async () => ({}) };
    }) as unknown as typeof fetch;

    renderWithProviders(<TemplateDetailDrawer slug={slug} onClose={jest.fn()} />);

    await waitFor(() => {
      expect(screen.getByText(message)).toBeInTheDocument();
    });
  });

  it('shows loading skeleton while fetching', async () => {
    let resolvePromise: (value: unknown) => void;
    const pendingPromise = new Promise((resolve) => {
      resolvePromise = resolve;
    });

    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/registry/templates/')) {
        await pendingPromise;
        return { ok: true, json: async () => mockTemplateDetail };
      }
      if (url.includes('/api/registry/projects/')) {
        return { ok: true, json: async () => ({ projects: [] }) };
      }
      return { ok: true, json: async () => ({}) };
    }) as unknown as typeof fetch;

    renderWithProviders(<TemplateDetailDrawer slug="test-template" onClose={jest.fn()} />);

    // Check for skeleton elements (Skeleton uses animate-pulse class)
    await waitFor(() => {
      const skeletons = document.querySelectorAll('.animate-pulse');
      expect(skeletons.length).toBeGreaterThan(0);
    });

    // Cleanup
    resolvePromise!({});
  });

  describe('Version compatibility warnings', () => {
    const templateWithHighMinVersion = {
      template: {
        slug: 'test-template',
        name: 'Test Template',
        description: 'A test template',
        authorName: 'Test Author',
        license: 'MIT',
        category: 'development',
        tags: [],
        requiredProviders: [],
        isOfficial: false,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-15T00:00:00Z',
      },
      versions: [
        {
          version: '1.0.0',
          minDevchainVersion: '99.0.0', // Higher than any realistic current version
          changelog: 'Requires future version',
          publishedAt: '2024-01-01T00:00:00Z',
          isLatest: true,
        },
      ],
    };

    it('displays Incompatible badge when template requires higher Devchain version', async () => {
      global.fetch = jest.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/api/registry/templates/')) {
          return { ok: true, json: async () => templateWithHighMinVersion };
        }
        if (url.includes('/api/registry/projects/')) {
          return { ok: true, json: async () => ({ projects: [] }) };
        }
        if (url.includes('/api/registry/cache/')) {
          return { ok: true, json: async () => ({ versions: [] }) };
        }
        if (url.includes('/health')) {
          return { ok: true, json: async () => ({ version: '0.4.0' }) };
        }
        return { ok: true, json: async () => ({}) };
      }) as unknown as typeof fetch;

      renderWithProviders(<TemplateDetailDrawer slug="test-template" onClose={jest.fn()} />);

      await waitFor(() => {
        expect(screen.getByText('Incompatible')).toBeInTheDocument();
      });

      {
        await waitFor(() => {
          const downloadButton = screen.getByRole('button', { name: /download/i });
          expect(downloadButton).toBeDisabled();
        });
      }
    });

    it('shows enabled download button for compatible versions', async () => {
      const compatibleTemplate = {
        template: templateWithHighMinVersion.template,
        versions: [
          {
            version: '1.0.0',
            minDevchainVersion: '0.1.0', // Lower than current version
            changelog: 'Compatible version',
            publishedAt: '2024-01-01T00:00:00Z',
            isLatest: true,
          },
        ],
      };

      global.fetch = jest.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/api/registry/templates/')) {
          return { ok: true, json: async () => compatibleTemplate };
        }
        if (url.includes('/api/registry/projects/')) {
          return { ok: true, json: async () => ({ projects: [] }) };
        }
        if (url.includes('/api/registry/cache/')) {
          return { ok: true, json: async () => ({ versions: [] }) };
        }
        if (url.includes('/health')) {
          return { ok: true, json: async () => ({ version: '0.4.0' }) };
        }
        return { ok: true, json: async () => ({}) };
      }) as unknown as typeof fetch;

      renderWithProviders(<TemplateDetailDrawer slug="test-template" onClose={jest.fn()} />);

      await waitFor(() => {
        const downloadButton = screen.getByRole('button', { name: /download/i });
        expect(downloadButton).not.toBeDisabled();
        expect(screen.queryByText('Incompatible')).not.toBeInTheDocument();
      });
    });
  });
});

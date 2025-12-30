import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { RegistryPage } from './RegistryPage';

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

const mockTemplates = [
  {
    slug: 'basic-template',
    name: 'Basic Template',
    description: 'A simple starter template',
    authorName: 'DevChain',
    category: 'development',
    tags: ['starter', 'minimal'],
    isOfficial: true,
    latestVersion: '1.0.0',
    totalDownloads: 100,
  },
  {
    slug: 'advanced-template',
    name: 'Advanced Template',
    description: 'Full-featured project template',
    authorName: 'Community',
    category: 'planning',
    tags: ['full', 'complete'],
    isOfficial: false,
    latestVersion: '2.0.0',
    totalDownloads: 50,
  },
];

// Mock for /api/templates (unified templates API used by DownloadedTemplates)
const mockUnifiedTemplates = {
  templates: [
    {
      slug: 'downloaded-template',
      name: 'Downloaded Template',
      description: 'A downloaded registry template',
      source: 'registry',
      versions: ['1.0.0'],
      latestVersion: '1.0.0',
    },
  ],
  total: 1,
};

describe('RegistryPage', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    if (originalFetch) {
      global.fetch = originalFetch;
    }
    jest.clearAllMocks();
  });

  it('renders page header', async () => {
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/registry/status')) {
        return { ok: true, json: async () => ({ available: true, url: 'https://test.com' }) };
      }
      if (url.includes('/api/registry/templates')) {
        return { ok: true, json: async () => ({ templates: [], total: 0 }) };
      }
      if (url.includes('/api/templates')) {
        return { ok: true, json: async () => ({ templates: [], total: 0 }) };
      }
      return { ok: true, json: async () => ({}) };
    }) as unknown as typeof fetch;

    renderWithProviders(<RegistryPage />);

    expect(screen.getByText('Template Registry')).toBeInTheDocument();
    expect(screen.getByText('Browse and install project templates')).toBeInTheDocument();
  });

  it('renders template grid with templates', async () => {
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/registry/status')) {
        return { ok: true, json: async () => ({ available: true, url: 'https://test.com' }) };
      }
      if (url.includes('/api/registry/templates')) {
        return {
          ok: true,
          json: async () => ({ templates: mockTemplates, total: 2, page: 1, limit: 20 }),
        };
      }
      if (url.includes('/api/templates')) {
        return { ok: true, json: async () => mockUnifiedTemplates };
      }
      return { ok: true, json: async () => ({}) };
    }) as unknown as typeof fetch;

    renderWithProviders(<RegistryPage />);

    await waitFor(() => {
      expect(screen.getByText('Basic Template')).toBeInTheDocument();
      expect(screen.getByText('Advanced Template')).toBeInTheDocument();
    });
  });

  it('shows offline banner when registry is unavailable', async () => {
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/registry/status')) {
        return { ok: true, json: async () => ({ available: false, url: 'https://test.com' }) };
      }
      if (url.includes('/api/registry/templates')) {
        return { ok: true, json: async () => ({ templates: [], total: 0 }) };
      }
      if (url.includes('/api/templates')) {
        return { ok: true, json: async () => ({ templates: [], total: 0 }) };
      }
      return { ok: true, json: async () => ({}) };
    }) as unknown as typeof fetch;

    renderWithProviders(<RegistryPage />);

    await waitFor(() => {
      expect(
        screen.getByText('Registry unavailable. Showing cached templates only.'),
      ).toBeInTheDocument();
    });
  });

  it('does not show offline banner when registry is available', async () => {
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/registry/status')) {
        return { ok: true, json: async () => ({ available: true, url: 'https://test.com' }) };
      }
      if (url.includes('/api/registry/templates')) {
        return { ok: true, json: async () => ({ templates: mockTemplates, total: 2 }) };
      }
      if (url.includes('/api/templates')) {
        return { ok: true, json: async () => mockUnifiedTemplates };
      }
      return { ok: true, json: async () => ({}) };
    }) as unknown as typeof fetch;

    renderWithProviders(<RegistryPage />);

    await waitFor(() => {
      expect(screen.getByText('Basic Template')).toBeInTheDocument();
    });

    expect(
      screen.queryByText('Registry unavailable. Showing cached templates only.'),
    ).not.toBeInTheDocument();
  });

  it('shows error state when template fetch fails', async () => {
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/registry/status')) {
        return { ok: true, json: async () => ({ available: true, url: 'https://test.com' }) };
      }
      if (url.includes('/api/registry/templates')) {
        return { ok: false, status: 500, statusText: 'Internal Server Error' };
      }
      if (url.includes('/api/templates')) {
        return { ok: true, json: async () => ({ templates: [], total: 0 }) };
      }
      return { ok: true, json: async () => ({}) };
    }) as unknown as typeof fetch;

    renderWithProviders(<RegistryPage />);

    await waitFor(() => {
      expect(screen.getByText('Failed to load templates')).toBeInTheDocument();
      expect(screen.getByText('Please check your connection and try again')).toBeInTheDocument();
    });
  });

  it('shows loading skeleton while fetching templates', async () => {
    // Create a promise that never resolves to keep loading state
    let resolvePromise: (value: unknown) => void;
    const pendingPromise = new Promise((resolve) => {
      resolvePromise = resolve;
    });

    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/registry/status')) {
        return { ok: true, json: async () => ({ available: true, url: 'https://test.com' }) };
      }
      if (url.includes('/api/registry/templates')) {
        await pendingPromise;
        return { ok: true, json: async () => ({ templates: [], total: 0 }) };
      }
      if (url.includes('/api/templates')) {
        return { ok: true, json: async () => ({ templates: [], total: 0 }) };
      }
      return { ok: true, json: async () => ({}) };
    }) as unknown as typeof fetch;

    renderWithProviders(<RegistryPage />);

    // Check for skeleton elements (Skeleton uses animate-pulse class)
    await waitFor(() => {
      const skeletons = document.querySelectorAll('.animate-pulse');
      expect(skeletons.length).toBeGreaterThan(0);
    });

    // Cleanup
    resolvePromise!({});
  });

  it('hides search input when filters are disabled', async () => {
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/registry/status')) {
        return { ok: true, json: async () => ({ available: true, url: 'https://test.com' }) };
      }
      if (url.includes('/api/registry/templates')) {
        return { ok: true, json: async () => ({ templates: [], total: 0 }) };
      }
      if (url.includes('/api/templates')) {
        return { ok: true, json: async () => ({ templates: [], total: 0 }) };
      }
      return { ok: true, json: async () => ({}) };
    }) as unknown as typeof fetch;

    renderWithProviders(<RegistryPage />);

    // Filters are hidden via SHOW_FILTERS = false feature flag
    const searchInput = screen.queryByPlaceholderText(/search/i);
    expect(searchInput).not.toBeInTheDocument();
  });

  it('shows Downloaded Templates section', async () => {
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/registry/status')) {
        return { ok: true, json: async () => ({ available: true, url: 'https://test.com' }) };
      }
      if (url.includes('/api/registry/templates')) {
        return { ok: true, json: async () => ({ templates: mockTemplates, total: 2 }) };
      }
      if (url.includes('/api/templates')) {
        return { ok: true, json: async () => mockUnifiedTemplates };
      }
      return { ok: true, json: async () => ({}) };
    }) as unknown as typeof fetch;

    renderWithProviders(<RegistryPage />);

    await waitFor(() => {
      // DownloadedTemplates is now rendered and shows the downloaded registry template
      expect(screen.getByText('Downloaded Template')).toBeInTheDocument();
    });
  });

  it('shows Browse Registry section header', async () => {
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/registry/status')) {
        return { ok: true, json: async () => ({ available: true, url: 'https://test.com' }) };
      }
      if (url.includes('/api/registry/templates')) {
        return { ok: true, json: async () => ({ templates: mockTemplates, total: 2 }) };
      }
      if (url.includes('/api/templates')) {
        return { ok: true, json: async () => mockUnifiedTemplates };
      }
      return { ok: true, json: async () => ({}) };
    }) as unknown as typeof fetch;

    renderWithProviders(<RegistryPage />);

    await waitFor(() => {
      expect(screen.getByText('Browse Registry')).toBeInTheDocument();
    });
  });
});

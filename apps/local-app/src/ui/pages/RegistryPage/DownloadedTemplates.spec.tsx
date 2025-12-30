import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DownloadedTemplates } from './DownloadedTemplates';

// Mock Radix Dialog portal to render inline for testing
jest.mock('@radix-ui/react-dialog', () => {
  const actual = jest.requireActual('@radix-ui/react-dialog');
  return {
    ...actual,
    Portal: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  };
});

// ResizeObserver mock for Radix components
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
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

describe('DownloadedTemplates', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.clearAllMocks();
  });

  describe('bundled and registry templates display', () => {
    it('shows bundled template in Installed Templates section', async () => {
      global.fetch = jest.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/api/templates')) {
          return {
            ok: true,
            json: async () => ({
              templates: [
                {
                  slug: 'bundled-template',
                  name: 'Bundled Template',
                  description: 'A built-in template',
                  source: 'bundled',
                  versions: null,
                  latestVersion: null,
                },
              ],
              total: 1,
            }),
          };
        }
        // Mock registry check - template not in registry
        if (url.includes('/api/registry/templates/')) {
          return { ok: true, json: async () => null };
        }
        return { ok: true, json: async () => ({}) };
      }) as unknown as typeof fetch;

      renderWithProviders(<DownloadedTemplates />);

      await waitFor(() => {
        expect(screen.getByText('Bundled Template')).toBeInTheDocument();
      });
    });

    it('shows "Bundled" badge for bundled templates', async () => {
      global.fetch = jest.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/api/templates')) {
          return {
            ok: true,
            json: async () => ({
              templates: [
                {
                  slug: 'bundled-template',
                  name: 'Bundled Template',
                  description: 'A built-in template',
                  source: 'bundled',
                  versions: null,
                  latestVersion: null,
                },
              ],
              total: 1,
            }),
          };
        }
        if (url.includes('/api/registry/templates/')) {
          return { ok: true, json: async () => null };
        }
        return { ok: true, json: async () => ({}) };
      }) as unknown as typeof fetch;

      renderWithProviders(<DownloadedTemplates />);

      await waitFor(() => {
        expect(screen.getByText('Bundled')).toBeInTheDocument();
      });
    });

    it('shows "Downloaded" badge for registry templates', async () => {
      global.fetch = jest.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/api/templates')) {
          return {
            ok: true,
            json: async () => ({
              templates: [
                {
                  slug: 'registry-template',
                  name: 'Registry Template',
                  description: 'A downloaded template',
                  source: 'registry',
                  versions: ['1.0.0'],
                  latestVersion: '1.0.0',
                },
              ],
              total: 1,
            }),
          };
        }
        if (url.includes('/api/registry/templates/')) {
          return {
            ok: true,
            json: async () => ({
              slug: 'registry-template',
              versions: [{ version: '1.0.0', isLatest: true }],
            }),
          };
        }
        return { ok: true, json: async () => ({}) };
      }) as unknown as typeof fetch;

      renderWithProviders(<DownloadedTemplates />);

      await waitFor(() => {
        expect(screen.getByText('Downloaded')).toBeInTheDocument();
      });
    });

    it('shows both bundled and registry templates together', async () => {
      global.fetch = jest.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/api/templates')) {
          return {
            ok: true,
            json: async () => ({
              templates: [
                {
                  slug: 'bundled-template',
                  name: 'Bundled Template',
                  description: 'A built-in template',
                  source: 'bundled',
                  versions: null,
                  latestVersion: null,
                },
                {
                  slug: 'registry-template',
                  name: 'Registry Template',
                  description: 'A downloaded template',
                  source: 'registry',
                  versions: ['1.0.0'],
                  latestVersion: '1.0.0',
                },
              ],
              total: 2,
            }),
          };
        }
        if (url.includes('/api/registry/templates/bundled-template')) {
          return { ok: true, json: async () => null };
        }
        if (url.includes('/api/registry/templates/registry-template')) {
          return {
            ok: true,
            json: async () => ({
              slug: 'registry-template',
              versions: [{ version: '1.0.0', isLatest: true }],
            }),
          };
        }
        return { ok: true, json: async () => ({}) };
      }) as unknown as typeof fetch;

      renderWithProviders(<DownloadedTemplates />);

      await waitFor(() => {
        expect(screen.getByText('Bundled Template')).toBeInTheDocument();
        expect(screen.getByText('Registry Template')).toBeInTheDocument();
        expect(screen.getByText('Bundled')).toBeInTheDocument();
        expect(screen.getByText('Downloaded')).toBeInTheDocument();
      });
    });
  });

  describe('bundled template update status', () => {
    it('shows download button for bundled template available in registry', async () => {
      global.fetch = jest.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/api/templates')) {
          return {
            ok: true,
            json: async () => ({
              templates: [
                {
                  slug: 'bundled-template',
                  name: 'Bundled Template',
                  description: 'A built-in template',
                  source: 'bundled',
                  versions: null,
                  latestVersion: null,
                },
              ],
              total: 1,
            }),
          };
        }
        if (url.includes('/api/registry/templates/bundled-template')) {
          return {
            ok: true,
            json: async () => ({
              slug: 'bundled-template',
              versions: [{ version: '1.0.0', isLatest: true }],
            }),
          };
        }
        return { ok: true, json: async () => ({}) };
      }) as unknown as typeof fetch;

      renderWithProviders(<DownloadedTemplates />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /Download v1\.0\.0/i })).toBeInTheDocument();
      });
    });

    it('shows "Not in registry" for bundled template not available in registry', async () => {
      global.fetch = jest.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/api/templates')) {
          return {
            ok: true,
            json: async () => ({
              templates: [
                {
                  slug: 'local-only-bundled',
                  name: 'Local Only Bundled',
                  description: 'A built-in template not in registry',
                  source: 'bundled',
                  versions: null,
                  latestVersion: null,
                },
              ],
              total: 1,
            }),
          };
        }
        if (url.includes('/api/registry/templates/')) {
          // Return null to indicate template not found in registry
          return { ok: true, json: async () => null };
        }
        return { ok: true, json: async () => ({}) };
      }) as unknown as typeof fetch;

      renderWithProviders(<DownloadedTemplates />);

      await waitFor(() => {
        expect(screen.getByText('Not in registry')).toBeInTheDocument();
      });
    });
  });

  describe('version expansion behavior', () => {
    it('does not show expand chevron for bundled templates', async () => {
      global.fetch = jest.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/api/templates')) {
          return {
            ok: true,
            json: async () => ({
              templates: [
                {
                  slug: 'bundled-template',
                  name: 'Bundled Template',
                  description: 'A built-in template',
                  source: 'bundled',
                  versions: null,
                  latestVersion: null,
                },
              ],
              total: 1,
            }),
          };
        }
        if (url.includes('/api/registry/templates/')) {
          return { ok: true, json: async () => null };
        }
        return { ok: true, json: async () => ({}) };
      }) as unknown as typeof fetch;

      renderWithProviders(<DownloadedTemplates />);

      await waitFor(() => {
        expect(screen.getByText('Bundled Template')).toBeInTheDocument();
      });

      // The bundled template item should not have role="button" (not expandable)
      const templateItem = screen.getByText('Bundled Template').closest('.rounded-lg');
      expect(templateItem).toBeInTheDocument();

      // Find the clickable area and verify it doesn't have button role
      const clickableArea = templateItem?.querySelector('[class*="flex w-full items-center"]');
      expect(clickableArea).not.toHaveAttribute('role', 'button');
    });

    it('shows expand chevron for registry templates with versions', async () => {
      global.fetch = jest.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/api/templates')) {
          return {
            ok: true,
            json: async () => ({
              templates: [
                {
                  slug: 'registry-template',
                  name: 'Registry Template',
                  description: 'A downloaded template',
                  source: 'registry',
                  versions: ['1.0.0', '0.9.0'],
                  latestVersion: '1.0.0',
                },
              ],
              total: 1,
            }),
          };
        }
        if (url.includes('/api/registry/templates/')) {
          return {
            ok: true,
            json: async () => ({
              slug: 'registry-template',
              versions: [{ version: '1.0.0', isLatest: true }],
            }),
          };
        }
        return { ok: true, json: async () => ({}) };
      }) as unknown as typeof fetch;

      renderWithProviders(<DownloadedTemplates />);

      await waitFor(() => {
        expect(screen.getByText('Registry Template')).toBeInTheDocument();
      });

      // The registry template item should have role="button" (expandable)
      const templateItem = screen.getByText('Registry Template').closest('.rounded-lg');
      const clickableArea = templateItem?.querySelector('[role="button"]');
      expect(clickableArea).toBeInTheDocument();
    });

    it('expands registry template to show cached versions', async () => {
      const user = userEvent.setup();

      global.fetch = jest.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/api/templates')) {
          return {
            ok: true,
            json: async () => ({
              templates: [
                {
                  slug: 'registry-template',
                  name: 'Registry Template',
                  description: 'A downloaded template',
                  source: 'registry',
                  versions: ['1.0.0', '0.9.0'],
                  latestVersion: '1.0.0',
                },
              ],
              total: 1,
            }),
          };
        }
        if (url.includes('/api/registry/templates/')) {
          return {
            ok: true,
            json: async () => ({
              slug: 'registry-template',
              versions: [{ version: '1.0.0', isLatest: true }],
            }),
          };
        }
        return { ok: true, json: async () => ({}) };
      }) as unknown as typeof fetch;

      renderWithProviders(<DownloadedTemplates />);

      await waitFor(() => {
        expect(screen.getByText('Registry Template')).toBeInTheDocument();
      });

      // Click to expand
      const templateItem = screen.getByText('Registry Template').closest('.rounded-lg');
      const clickableArea = templateItem?.querySelector('[role="button"]');
      expect(clickableArea).toBeInTheDocument();

      await user.click(clickableArea!);

      // Should show cached versions section
      await waitFor(() => {
        expect(screen.getByText('Cached Versions')).toBeInTheDocument();
      });

      // Find the expanded versions section and verify both versions are shown
      const versionsSection = screen.getByText('Cached Versions').closest('div');
      expect(versionsSection).toBeInTheDocument();
      // v1.0.0 appears in both header badge and cached versions, v0.9.0 only in cached versions
      expect(screen.getByText('v0.9.0')).toBeInTheDocument();
      // Use getAllByText since v1.0.0 appears twice (header + expanded)
      expect(screen.getAllByText('v1.0.0').length).toBeGreaterThanOrEqual(1);
    });

    it('shows "Built-in template" for bundled templates instead of version count', async () => {
      global.fetch = jest.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/api/templates')) {
          return {
            ok: true,
            json: async () => ({
              templates: [
                {
                  slug: 'bundled-template',
                  name: 'Bundled Template',
                  description: 'A built-in template',
                  source: 'bundled',
                  versions: null,
                  latestVersion: null,
                },
              ],
              total: 1,
            }),
          };
        }
        if (url.includes('/api/registry/templates/')) {
          return { ok: true, json: async () => null };
        }
        return { ok: true, json: async () => ({}) };
      }) as unknown as typeof fetch;

      renderWithProviders(<DownloadedTemplates />);

      await waitFor(() => {
        expect(screen.getByText('Built-in template')).toBeInTheDocument();
      });
    });

    it('shows version count for registry templates', async () => {
      global.fetch = jest.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/api/templates')) {
          return {
            ok: true,
            json: async () => ({
              templates: [
                {
                  slug: 'registry-template',
                  name: 'Registry Template',
                  description: 'A downloaded template',
                  source: 'registry',
                  versions: ['1.0.0', '0.9.0'],
                  latestVersion: '1.0.0',
                },
              ],
              total: 1,
            }),
          };
        }
        if (url.includes('/api/registry/templates/')) {
          return {
            ok: true,
            json: async () => ({
              slug: 'registry-template',
              versions: [{ version: '1.0.0', isLatest: true }],
            }),
          };
        }
        return { ok: true, json: async () => ({}) };
      }) as unknown as typeof fetch;

      renderWithProviders(<DownloadedTemplates />);

      await waitFor(() => {
        expect(screen.getByText('2 versions cached')).toBeInTheDocument();
      });
    });
  });

  describe('section header', () => {
    it('shows "Installed Templates" as section title', async () => {
      global.fetch = jest.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/api/templates')) {
          return {
            ok: true,
            json: async () => ({
              templates: [],
              total: 0,
            }),
          };
        }
        return { ok: true, json: async () => ({}) };
      }) as unknown as typeof fetch;

      renderWithProviders(<DownloadedTemplates />);

      await waitFor(() => {
        expect(screen.getByText('Installed Templates')).toBeInTheDocument();
      });
    });

    it('shows template count badge', async () => {
      global.fetch = jest.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/api/templates')) {
          return {
            ok: true,
            json: async () => ({
              templates: [
                {
                  slug: 'bundled-template',
                  name: 'Bundled Template',
                  source: 'bundled',
                  versions: null,
                  latestVersion: null,
                },
                {
                  slug: 'registry-template',
                  name: 'Registry Template',
                  source: 'registry',
                  versions: ['1.0.0'],
                  latestVersion: '1.0.0',
                },
              ],
              total: 2,
            }),
          };
        }
        if (url.includes('/api/registry/templates/')) {
          return { ok: true, json: async () => null };
        }
        return { ok: true, json: async () => ({}) };
      }) as unknown as typeof fetch;

      renderWithProviders(<DownloadedTemplates />);

      await waitFor(() => {
        // Find the badge showing count "2" in the header
        const header = screen.getByText('Installed Templates').closest('div');
        expect(within(header!).getByText('2')).toBeInTheDocument();
      });
    });
  });

  describe('empty state', () => {
    it('shows empty state when no templates installed', async () => {
      global.fetch = jest.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/api/templates')) {
          return {
            ok: true,
            json: async () => ({
              templates: [],
              total: 0,
            }),
          };
        }
        return { ok: true, json: async () => ({}) };
      }) as unknown as typeof fetch;

      renderWithProviders(<DownloadedTemplates />);

      await waitFor(() => {
        expect(screen.getByText('No installed templates')).toBeInTheDocument();
        expect(
          screen.getByText('Download templates from the registry or add bundled templates'),
        ).toBeInTheDocument();
      });
    });
  });
});

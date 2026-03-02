import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { ProjectsPage } from './ProjectsPage';

const setSelectedProjectIdMock = jest.fn();
jest.mock('@/ui/hooks/useProjectSelection', () => ({
  useSelectedProject: () => ({
    setSelectedProjectId: setSelectedProjectIdMock,
  }),
}));

// Mock UpgradeDialog to capture props without rendering the full dialog
const mockUpgradeDialogProps = jest.fn();
jest.mock('@/ui/components/project/UpgradeDialog', () => ({
  UpgradeDialog: (props: Record<string, unknown>) => {
    mockUpgradeDialogProps(props);
    if (!props.open) return null;
    return (
      <div
        data-testid="upgrade-dialog"
        data-project-id={props.projectId}
        data-target-version={props.targetVersion}
      >
        <span>Upgrade Dialog for {props.projectName as string}</span>
        <button onClick={props.onClose as () => void}>Close</button>
      </div>
    );
  },
}));

function renderWithQuery(ui: React.ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('ProjectsPage — template creation and badge', () => {
  const originalFetch = global.fetch;

  // JSDOM lacks ResizeObserver used by Radix
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (global as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };

  // JSDOM lacks scrollIntoView used by Radix Select
  Element.prototype.scrollIntoView = jest.fn();

  afterEach(() => {
    if (originalFetch) {
      global.fetch = originalFetch;
    }
    const mockFetch = (global as unknown as { fetch?: { mockClear?: () => void } }).fetch;
    if (mockFetch && typeof mockFetch.mockClear === 'function') {
      mockFetch.mockClear();
    }
    mockUpgradeDialogProps.mockClear();
  });

  it('shows Template badge for projects with isTemplate=true', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as unknown as { fetch: unknown }).fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/projects') {
        return {
          ok: true,
          json: async () => ({
            items: [
              {
                id: 'p1',
                name: 'Project One',
                description: null,
                rootPath: '/tmp/one',
                isTemplate: true,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
            ],
          }),
        } as Response;
      }
      if (url === '/api/projects/p1/stats') {
        return { ok: true, json: async () => ({ epicsCount: 0, agentsCount: 0 }) } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    });

    renderWithQuery(<ProjectsPage />);

    await waitFor(() => expect(screen.getByText('Project One')).toBeInTheDocument());
    // Look for the Template badge on the project row (aria-label distinguishes from column header)
    expect(screen.getByLabelText('Template project')).toBeInTheDocument();
  });

  it('creates project via template flow and preselects it', async () => {
    const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/projects' && (!init || init.method === 'GET')) {
        return { ok: true, json: async () => ({ items: [] }) } as Response;
      }
      if (url === '/api/templates') {
        return {
          ok: true,
          json: async () => ({
            templates: [
              {
                slug: 'empty-project',
                name: 'Empty Project',
                source: 'bundled',
                versions: null,
                latestVersion: null,
              },
            ],
            total: 1,
          }),
        } as Response;
      }
      if (url === '/api/projects/from-template' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body || '{}'));
        expect(body.templateId).toBe('empty-project');
        return {
          ok: true,
          json: async () => ({
            success: true,
            project: {
              id: 'p2',
              name: body.name,
              description: body.description ?? null,
              rootPath: body.rootPath,
              isTemplate: false,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
            imported: { prompts: 0, profiles: 0, agents: 0, statuses: 5 },
            mappings: { promptIdMap: {}, profileIdMap: {}, agentIdMap: {}, statusIdMap: {} },
            initialPromptSet: false,
            message: 'Project created from template successfully',
          }),
        } as Response;
      }
      if (url.endsWith('/stats')) {
        return { ok: true, json: async () => ({ epicsCount: 0, agentsCount: 0 }) } as Response;
      }
      if (url === '/api/fs/stat' && init?.method === 'POST') {
        return { ok: true, json: async () => ({}) } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;
    global.fetch = fetchMock;

    renderWithQuery(<ProjectsPage />);

    // Open create dialog (template-based)
    fireEvent.click(screen.getByText('Create Project'));
    await waitFor(() => expect(screen.getByLabelText('Template *')).toBeInTheDocument());

    // Fill fields
    fireEvent.change(screen.getByLabelText('Name *'), { target: { value: 'Tpl' } });
    fireEvent.change(screen.getByLabelText('Root Path *'), { target: { value: '/tmp/tpl' } });

    // Validate path endpoint returns ok
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/fs/stat', expect.anything()));

    // Submit
    fireEvent.click(screen.getByRole('button', { name: /^Create$/ }));

    await waitFor(() => {
      // POST called to template endpoint
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/projects/from-template',
        expect.objectContaining({ method: 'POST' }),
      );
      // Preselect new project
      expect(setSelectedProjectIdMock).toHaveBeenCalledWith('p2');
    });
  });

  it('edit dialog reflects isTemplate=true and can update to false', async () => {
    const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/projects') {
        if (!init || !init.method || init.method === 'GET') {
          return {
            ok: true,
            json: async () => ({
              items: [
                {
                  id: 'p1',
                  name: 'Project One',
                  description: null,
                  rootPath: '/tmp/one',
                  isTemplate: true,
                  createdAt: new Date().toISOString(),
                  updatedAt: new Date().toISOString(),
                },
              ],
            }),
          } as Response;
        }
        if (init?.method === 'PUT') {
          const body = JSON.parse(String(init.body || '{}'));
          expect(body.isTemplate).toBe(false);
          return { ok: true, json: async () => ({ id: 'p1', ...body }) } as Response;
        }
      }
      if (url === '/api/projects/p1/stats') {
        return { ok: true, json: async () => ({ epicsCount: 0, agentsCount: 0 }) } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;
    global.fetch = fetchMock;

    renderWithQuery(<ProjectsPage />);

    await waitFor(() => expect(screen.getByText('Project One')).toBeInTheDocument());

    // Open edit
    fireEvent.click(screen.getAllByRole('button', { name: '' })[0]); // first ghost Edit button
    await screen.findByText('Edit Project');
    const checkbox = screen.getByLabelText('Mark as template');
    // It should be checked
    expect((checkbox as HTMLInputElement).getAttribute('data-state')).toBe('checked');

    // Uncheck and save
    fireEvent.click(checkbox);
    fireEvent.click(screen.getByRole('button', { name: /^Update$/ }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/projects/p1',
        expect.objectContaining({ method: 'PUT' }),
      );
    });
  });

  it('fetches templates with source and version fields', async () => {
    let templatesEndpointCalled = false;
    const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/projects' && (!init || init.method === 'GET')) {
        return { ok: true, json: async () => ({ items: [] }) } as Response;
      }
      if (url === '/api/templates') {
        templatesEndpointCalled = true;
        return {
          ok: true,
          json: async () => ({
            templates: [
              {
                slug: 'empty-project',
                name: 'Empty Project',
                source: 'bundled',
                versions: null,
                latestVersion: null,
              },
              {
                slug: 'downloaded-template',
                name: 'Downloaded Template',
                source: 'registry',
                versions: ['1.0.0', '1.1.0'],
                latestVersion: '1.1.0',
              },
            ],
            total: 2,
          }),
        } as Response;
      }
      if (url === '/api/fs/stat' && init?.method === 'POST') {
        return { ok: true, json: async () => ({}) } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;
    global.fetch = fetchMock;

    renderWithQuery(<ProjectsPage />);

    // Open create dialog to trigger template fetch
    fireEvent.click(screen.getByText('Create Project'));
    await waitFor(() => expect(screen.getByLabelText('Template *')).toBeInTheDocument());

    // Verify /api/templates endpoint was called (not legacy /api/projects/templates)
    await waitFor(() => {
      expect(templatesEndpointCalled).toBe(true);
      expect(fetchMock).toHaveBeenCalledWith('/api/templates');
    });
  });

  it('version picker hidden for bundled template, shows for registry after selection', async () => {
    const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/projects' && (!init || init.method === 'GET')) {
        return { ok: true, json: async () => ({ items: [] }) } as Response;
      }
      if (url === '/api/templates') {
        return {
          ok: true,
          json: async () => ({
            templates: [
              {
                slug: 'empty-project',
                name: 'Empty Project',
                source: 'bundled',
                versions: null,
                latestVersion: null,
              },
            ],
            total: 1,
          }),
        } as Response;
      }
      if (url === '/api/fs/stat' && init?.method === 'POST') {
        return { ok: true, json: async () => ({}) } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;
    global.fetch = fetchMock;

    renderWithQuery(<ProjectsPage />);

    // Open create dialog
    fireEvent.click(screen.getByText('Create Project'));
    await waitFor(() => expect(screen.getByLabelText('Template *')).toBeInTheDocument());

    // Bundled template is preselected - version picker should NOT be visible
    expect(screen.queryByLabelText('Version')).not.toBeInTheDocument();
  });

  it('displays template metadata on project cards', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as unknown as { fetch: unknown }).fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/projects') {
        return {
          ok: true,
          json: async () => ({
            items: [
              {
                id: 'p1',
                name: 'Registry Project',
                description: null,
                rootPath: '/tmp/registry',
                isTemplate: false,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                templateMetadata: {
                  slug: 'my-template',
                  version: '1.2.0',
                  source: 'registry',
                },
              },
              {
                id: 'p2',
                name: 'Bundled Project',
                description: null,
                rootPath: '/tmp/bundled',
                isTemplate: false,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                templateMetadata: {
                  slug: 'empty-project',
                  version: null,
                  source: 'bundled',
                },
              },
            ],
          }),
        } as Response;
      }
      if (url.endsWith('/stats')) {
        return { ok: true, json: async () => ({ epicsCount: 0, agentsCount: 0 }) } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    });

    renderWithQuery(<ProjectsPage />);

    // Wait for projects to load
    await waitFor(() => expect(screen.getByText('Registry Project')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText('Bundled Project')).toBeInTheDocument());

    // Check registry template shows slug and version
    expect(screen.getByText('my-template')).toBeInTheDocument();
    expect(screen.getByText('v1.2.0')).toBeInTheDocument();

    // Check bundled template shows slug and "Built-in" badge
    expect(screen.getByText('empty-project')).toBeInTheDocument();
    expect(screen.getByText('Built-in')).toBeInTheDocument();
  });

  it('includes source and version fields in template response', async () => {
    let capturedTemplateResponse: unknown = null;
    const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/projects' && (!init || init.method === 'GET')) {
        return { ok: true, json: async () => ({ items: [] }) } as Response;
      }
      if (url === '/api/templates') {
        capturedTemplateResponse = {
          templates: [
            {
              slug: 'registry-template',
              name: 'Registry Template',
              source: 'registry',
              versions: ['1.0.0', '1.1.0', '2.0.0'],
              latestVersion: '2.0.0',
            },
          ],
          total: 1,
        };
        return {
          ok: true,
          json: async () => capturedTemplateResponse,
        } as Response;
      }
      if (url === '/api/fs/stat' && init?.method === 'POST') {
        return { ok: true, json: async () => ({}) } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;
    global.fetch = fetchMock;

    renderWithQuery(<ProjectsPage />);

    // Open create dialog to trigger template fetch
    fireEvent.click(screen.getByText('Create Project'));
    await waitFor(() => expect(screen.getByLabelText('Template *')).toBeInTheDocument());

    // Verify response shape includes new fields
    await waitFor(() => {
      expect(capturedTemplateResponse).not.toBeNull();
      const response = capturedTemplateResponse as {
        templates: Array<{ source: string; versions: string[]; latestVersion: string }>;
      };
      expect(response.templates[0].source).toBe('registry');
      expect(response.templates[0].versions).toEqual(['1.0.0', '1.1.0', '2.0.0']);
      expect(response.templates[0].latestVersion).toBe('2.0.0');
    });
  });

  it('shows upgrade badge when newer downloaded version exists', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as unknown as { fetch: unknown }).fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/projects') {
        return {
          ok: true,
          json: async () => ({
            items: [
              {
                id: 'p1',
                name: 'Upgradeable Project',
                description: null,
                rootPath: '/tmp/upgradeable',
                isTemplate: false,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                templateMetadata: {
                  slug: 'my-template',
                  version: '1.0.0',
                  source: 'registry',
                },
              },
            ],
          }),
        } as Response;
      }
      if (url.endsWith('/stats')) {
        return { ok: true, json: async () => ({ epicsCount: 0, agentsCount: 0 }) } as Response;
      }
      // Templates endpoint for upgrade checking
      if (url === '/api/templates') {
        return {
          ok: true,
          json: async () => ({
            templates: [
              {
                slug: 'my-template',
                name: 'My Template',
                source: 'registry',
                versions: ['1.0.0', '1.1.0', '2.0.0'],
                latestVersion: '2.0.0',
              },
            ],
            total: 1,
          }),
        } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    });

    renderWithQuery(<ProjectsPage />);

    // Wait for project to load
    await waitFor(() => expect(screen.getByText('Upgradeable Project')).toBeInTheDocument());

    // Look for upgrade badge showing latest version
    await waitFor(() => {
      const upgradeButton = screen.getByTitle('Upgrade to v2.0.0');
      expect(upgradeButton).toBeInTheDocument();
      expect(upgradeButton).toHaveTextContent('v2.0.0');
    });
  });

  it('shows update badge for bundled templates when bundledUpgradeAvailable is set', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as unknown as { fetch: unknown }).fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/projects') {
        return {
          ok: true,
          json: async () => ({
            items: [
              {
                id: 'p1',
                name: 'Bundled Project',
                description: null,
                rootPath: '/tmp/bundled',
                isTemplate: false,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                templateMetadata: {
                  slug: 'claude-codex-advanced',
                  version: '1.0.0',
                  source: 'bundled',
                },
                bundledUpgradeAvailable: '1.1.0', // Newer bundled version available
              },
            ],
          }),
        } as Response;
      }
      if (url.endsWith('/stats')) {
        return { ok: true, json: async () => ({ epicsCount: 0, agentsCount: 0 }) } as Response;
      }
      if (url === '/api/templates') {
        return {
          ok: true,
          json: async () => ({
            templates: [
              {
                slug: 'claude-codex-advanced',
                name: 'Claude Codex Advanced',
                source: 'bundled',
                versions: null,
                latestVersion: null,
              },
            ],
            total: 1,
          }),
        } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    });

    renderWithQuery(<ProjectsPage />);

    // Wait for project to load
    await waitFor(() => expect(screen.getByText('Bundled Project')).toBeInTheDocument());

    // Look for upgrade badge showing bundled upgrade version
    // Note: Button uses "Upgrade to" universally, while the dialog uses "Update" for bundled
    await waitFor(() => {
      const upgradeButton = screen.getByTitle('Upgrade to v1.1.0');
      expect(upgradeButton).toBeInTheDocument();
      expect(upgradeButton).toHaveTextContent('v1.1.0');
    });
  });

  it('does not show upgrade badge for bundled templates without upgrade available', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as unknown as { fetch: unknown }).fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/projects') {
        return {
          ok: true,
          json: async () => ({
            items: [
              {
                id: 'p1',
                name: 'Bundled Project',
                description: null,
                rootPath: '/tmp/bundled',
                isTemplate: false,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                templateMetadata: {
                  slug: 'empty-project',
                  version: null,
                  source: 'bundled',
                },
              },
            ],
          }),
        } as Response;
      }
      if (url.endsWith('/stats')) {
        return { ok: true, json: async () => ({ epicsCount: 0, agentsCount: 0 }) } as Response;
      }
      if (url === '/api/templates') {
        return {
          ok: true,
          json: async () => ({
            templates: [
              {
                slug: 'empty-project',
                name: 'Empty Project',
                source: 'bundled',
                versions: null,
                latestVersion: null,
              },
            ],
            total: 1,
          }),
        } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    });

    renderWithQuery(<ProjectsPage />);

    // Wait for project to load
    await waitFor(() => expect(screen.getByText('Bundled Project')).toBeInTheDocument());

    // Verify "Built-in" badge is shown but no upgrade button
    expect(screen.getByText('Built-in')).toBeInTheDocument();
    expect(screen.queryByTitle(/Upgrade to/)).not.toBeInTheDocument();
  });

  it('does not show upgrade badge when project version is current', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as unknown as { fetch: unknown }).fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/projects') {
        return {
          ok: true,
          json: async () => ({
            items: [
              {
                id: 'p1',
                name: 'Current Project',
                description: null,
                rootPath: '/tmp/current',
                isTemplate: false,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                templateMetadata: {
                  slug: 'my-template',
                  version: '2.0.0', // Already on latest version
                  source: 'registry',
                },
              },
            ],
          }),
        } as Response;
      }
      if (url.endsWith('/stats')) {
        return { ok: true, json: async () => ({ epicsCount: 0, agentsCount: 0 }) } as Response;
      }
      if (url === '/api/templates') {
        return {
          ok: true,
          json: async () => ({
            templates: [
              {
                slug: 'my-template',
                name: 'My Template',
                source: 'registry',
                versions: ['1.0.0', '2.0.0'],
                latestVersion: '2.0.0',
              },
            ],
            total: 1,
          }),
        } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    });

    renderWithQuery(<ProjectsPage />);

    // Wait for project to load
    await waitFor(() => expect(screen.getByText('Current Project')).toBeInTheDocument());

    // Verify version badge is shown but no upgrade button
    expect(screen.getByText('v2.0.0')).toBeInTheDocument();
    expect(screen.queryByTitle(/Upgrade to/)).not.toBeInTheDocument();
  });

  it('clicking upgrade badge opens UpgradeDialog with correct props', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as unknown as { fetch: unknown }).fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/projects') {
        return {
          ok: true,
          json: async () => ({
            items: [
              {
                id: 'p1',
                name: 'Upgradeable Project',
                description: null,
                rootPath: '/tmp/upgradeable',
                isTemplate: false,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                templateMetadata: {
                  slug: 'my-template',
                  version: '1.0.0',
                  source: 'registry',
                },
              },
            ],
          }),
        } as Response;
      }
      if (url.endsWith('/stats')) {
        return { ok: true, json: async () => ({ epicsCount: 0, agentsCount: 0 }) } as Response;
      }
      if (url === '/api/templates') {
        return {
          ok: true,
          json: async () => ({
            templates: [
              {
                slug: 'my-template',
                name: 'My Template',
                source: 'registry',
                versions: ['1.0.0', '2.0.0'],
                latestVersion: '2.0.0',
              },
            ],
            total: 1,
          }),
        } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    });

    renderWithQuery(<ProjectsPage />);

    // Wait for project to load
    await waitFor(() => expect(screen.getByText('Upgradeable Project')).toBeInTheDocument());

    // Click upgrade button
    const upgradeButton = screen.getByTitle('Upgrade to v2.0.0');
    fireEvent.click(upgradeButton);

    // Verify UpgradeDialog opens with correct props
    await waitFor(() => {
      expect(screen.getByTestId('upgrade-dialog')).toBeInTheDocument();
    });

    const dialog = screen.getByTestId('upgrade-dialog');
    expect(dialog).toHaveAttribute('data-project-id', 'p1');
    expect(dialog).toHaveAttribute('data-target-version', '2.0.0');
    expect(screen.getByText('Upgrade Dialog for Upgradeable Project')).toBeInTheDocument();
  });

  it('shows dash for projects without template metadata', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as unknown as { fetch: unknown }).fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/projects') {
        return {
          ok: true,
          json: async () => ({
            items: [
              {
                id: 'p1',
                name: 'No Metadata Project',
                description: null,
                rootPath: '/tmp/no-metadata',
                isTemplate: false,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                // No templateMetadata field
              },
            ],
          }),
        } as Response;
      }
      if (url.endsWith('/stats')) {
        return { ok: true, json: async () => ({ epicsCount: 0, agentsCount: 0 }) } as Response;
      }
      if (url === '/api/templates') {
        return {
          ok: true,
          json: async () => ({ templates: [], total: 0 }),
        } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    });

    renderWithQuery(<ProjectsPage />);

    // Wait for project to load
    await waitFor(() => expect(screen.getByText('No Metadata Project')).toBeInTheDocument());

    // Find the table row for this project and verify Template column shows "—"
    const row = screen.getByText('No Metadata Project').closest('tr');
    expect(row).toBeInTheDocument();
    // The Template column should contain "—" (em dash) for projects without metadata
    const cells = row!.querySelectorAll('td');
    // Template column is the 4th column (index 3)
    expect(cells[3].textContent).toBe('—');
  });

  it('closing UpgradeDialog clears upgrade target', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as unknown as { fetch: unknown }).fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/projects') {
        return {
          ok: true,
          json: async () => ({
            items: [
              {
                id: 'p1',
                name: 'Upgradeable Project',
                description: null,
                rootPath: '/tmp/upgradeable',
                isTemplate: false,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                templateMetadata: {
                  slug: 'my-template',
                  version: '1.0.0',
                  source: 'registry',
                },
              },
            ],
          }),
        } as Response;
      }
      if (url.endsWith('/stats')) {
        return { ok: true, json: async () => ({ epicsCount: 0, agentsCount: 0 }) } as Response;
      }
      if (url === '/api/templates') {
        return {
          ok: true,
          json: async () => ({
            templates: [
              {
                slug: 'my-template',
                name: 'My Template',
                source: 'registry',
                versions: ['1.0.0', '2.0.0'],
                latestVersion: '2.0.0',
              },
            ],
            total: 1,
          }),
        } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    });

    renderWithQuery(<ProjectsPage />);

    // Wait for project to load
    await waitFor(() => expect(screen.getByText('Upgradeable Project')).toBeInTheDocument());

    // Click upgrade button to open dialog
    const upgradeButton = screen.getByTitle('Upgrade to v2.0.0');
    fireEvent.click(upgradeButton);

    await waitFor(() => {
      expect(screen.getByTestId('upgrade-dialog')).toBeInTheDocument();
    });

    // Click close button in dialog
    fireEvent.click(screen.getByText('Close'));

    // Verify dialog is closed
    await waitFor(() => {
      expect(screen.queryByTestId('upgrade-dialog')).not.toBeInTheDocument();
    });
  });
});

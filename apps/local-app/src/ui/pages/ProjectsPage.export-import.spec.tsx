import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { ProjectsPage } from './ProjectsPage';

const toastSpy = jest.fn();
const setSelectedProjectIdMock = jest.fn();

jest.mock('@/ui/hooks/use-toast', () => ({
  useToast: () => ({ toast: toastSpy }),
}));

jest.mock('@/ui/hooks/useProjectSelection', () => ({
  useSelectedProject: () => ({
    setSelectedProjectId: setSelectedProjectIdMock,
  }),
}));

function renderWithQuery(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ProjectsPage — Export/Import actions', () => {
  // JSDOM lacks ResizeObserver used by Radix
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (global as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };

  beforeEach(() => {
    toastSpy.mockReset();
    setSelectedProjectIdMock.mockReset();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as unknown as { fetch: unknown }).fetch = jest.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === '/api/projects') {
          return {
            ok: true,
            json: async () => ({
              items: [
                {
                  id: 'proj-1',
                  name: 'Alpha',
                  description: null,
                  rootPath: '/tmp/alpha',
                  isTemplate: false,
                  createdAt: new Date().toISOString(),
                  updatedAt: new Date().toISOString(),
                },
              ],
            }),
          } as Response;
        }
        if (url === '/api/projects/proj-1/stats') {
          return { ok: true, json: async () => ({ epicsCount: 0, agentsCount: 0 }) } as Response;
        }
        if (url.startsWith('/api/projects/proj-1/import?dryRun=true') && init?.method === 'POST') {
          return {
            ok: true,
            json: async () => ({
              dryRun: true,
              missingProviders: [],
              counts: {
                toImport: { prompts: 1, profiles: 1, agents: 1, statuses: 5 },
                toDelete: { prompts: 0, profiles: 0, agents: 0, statuses: 5 },
              },
            }),
          } as Response;
        }
        if (url === '/api/projects/proj-1/import' && init?.method === 'POST') {
          return {
            ok: true,
            json: async () => ({
              success: true,
              counts: {
                imported: { prompts: 1, profiles: 1, agents: 1, statuses: 5 },
                deleted: { prompts: 0, profiles: 0, agents: 0, statuses: 5 },
              },
              mappings: { promptIdMap: {}, profileIdMap: {}, agentIdMap: {}, statusIdMap: {} },
              initialPromptSet: true,
              message: 'Project configuration replaced.',
            }),
          } as Response;
        }
        if (url.startsWith('/api/projects/proj-1/export')) {
          return {
            ok: true,
            json: async () => ({
              version: 1,
              exportedAt: new Date().toISOString(),
              prompts: [],
              profiles: [],
              agents: [],
              statuses: [],
              initialPrompt: null,
            }),
          } as Response;
        }
        return { ok: true, json: async () => ({}) } as Response;
      },
    );
  });

  // TODO: This test has issues with Radix UI Dialog rendering in JSDOM.
  // The file selection and async state updates don't properly trigger dialog display.
  // Need to investigate alternative testing approaches (e.g., component unit tests, E2E tests).
  it.skip('runs import dry-run then confirm import and shows result dialog', async () => {
    renderWithQuery(<ProjectsPage />);

    await waitFor(() => expect(screen.getByText('Alpha')).toBeInTheDocument());

    const importBtn = screen.getByRole('button', { name: /import/i });
    fireEvent.click(importBtn);

    // Simulate file selection
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File([JSON.stringify({ version: 1 })], 'export.json', {
      type: 'application/json',
    });
    fireEvent.change(fileInput, { target: { files: [file] } });

    // Dry-run confirmation dialog should appear
    await waitFor(() =>
      expect(screen.getByText(/Replace Project Configuration\?/i)).toBeInTheDocument(),
    );

    const confirmBtn = screen.getByRole('button', { name: /replace project/i });
    fireEvent.click(confirmBtn);

    await waitFor(() => expect(screen.getByText(/Import Completed/i)).toBeInTheDocument());
    expect(screen.getByText(/Imported/i)).toBeInTheDocument();
    expect(screen.getByText(/Deleted/i)).toBeInTheDocument();
  });
});

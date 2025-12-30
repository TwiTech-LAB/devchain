import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SettingsPage } from './SettingsPage';

const toastSpy = jest.fn();
const useSelectedProjectMock = jest.fn();

jest.mock('@/ui/hooks/useProjectSelection', () => ({
  useSelectedProject: () => useSelectedProjectMock(),
}));

jest.mock('@/ui/hooks/use-toast', () => ({
  useToast: () => ({ toast: toastSpy }),
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

beforeAll(() => {
  // JSDOM does not implement scrollIntoView
  if (!HTMLElement.prototype.scrollIntoView) {
    HTMLElement.prototype.scrollIntoView = () => {};
  }
});

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );

  return { Wrapper, queryClient };
}

describe('SettingsPage initial session prompt selector', () => {
  const originalFetch = global.fetch;
  const fetchMock = jest.fn();

  beforeEach(() => {
    useSelectedProjectMock.mockReturnValue({
      selectedProjectId: 'project-1',
      selectedProject: { id: 'project-1', name: 'Demo' },
      projects: [],
      projectsLoading: false,
      projectsError: false,
      refetchProjects: jest.fn(),
      setSelectedProjectId: jest.fn(),
    });

    let currentSettings = {
      initialSessionPromptIds: { 'project-1': 'prompt-1' },
      terminal: { scrollbackLines: 10000 },
    };
    const promptsResponse = {
      items: [
        { id: 'prompt-1', title: 'Prompt One' },
        { id: 'prompt-2', title: 'Prompt Two' },
      ],
      total: 2,
      limit: 2,
      offset: 0,
    };

    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url.startsWith('/api/settings') && (!init || !init.method || init.method === 'GET')) {
        return {
          ok: true,
          json: async () => currentSettings,
        } as Response;
      }

      if (url === '/api/prompts?projectId=project-1') {
        return {
          ok: true,
          json: async () => promptsResponse,
        } as Response;
      }

      if (url.startsWith('/api/preflight')) {
        return {
          ok: true,
          json: async () => ({
            overall: 'pass',
            checks: [],
            providers: [],
            timestamp: new Date().toISOString(),
          }),
        } as Response;
      }

      if (url === '/api/settings' && init?.method === 'PUT') {
        const payload = init.body ? JSON.parse(init.body.toString()) : {};
        // Handle initialSessionPromptId updates for specific project
        if ('initialSessionPromptId' in payload && 'projectId' in payload) {
          currentSettings = {
            ...currentSettings,
            initialSessionPromptIds: {
              ...currentSettings.initialSessionPromptIds,
              [payload.projectId]: payload.initialSessionPromptId,
            },
          };
        } else {
          currentSettings = { ...currentSettings, ...payload };
        }
        return {
          ok: true,
          json: async () => currentSettings,
        } as Response;
      }

      return {
        ok: true,
        json: async () => ({}),
      } as Response;
    });

    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    fetchMock.mockReset();
    toastSpy.mockReset();
  });

  it('updates and persists the selected initial session prompt', async () => {
    const { Wrapper } = createWrapper();

    await act(async () => {
      render(
        <Wrapper>
          <SettingsPage />
        </Wrapper>,
      );
    });

    const selectElement = await screen.findByLabelText(/Initial prompt/i);
    await waitFor(() => expect(selectElement).toHaveValue('prompt-1'));

    await act(async () => {
      fireEvent.change(selectElement, { target: { value: 'prompt-2' } });
    });

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/settings',
        expect.objectContaining({ method: 'PUT' }),
      ),
    );

    const putCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
    expect(putCall).toBeTruthy();
    const body = JSON.parse((putCall?.[1]?.body as string) ?? '{}');
    expect(body.initialSessionPromptId).toBe('prompt-2');
    expect(body.projectId).toBe('project-1');

    await waitFor(() => expect(selectElement).toHaveValue('prompt-2'));
  });
});

describe('SettingsPage events template editor', () => {
  const originalFetch = global.fetch;
  const fetchMock = jest.fn();

  beforeEach(() => {
    useSelectedProjectMock.mockReturnValue({
      selectedProjectId: null,
      selectedProject: null,
      projects: [],
      projectsLoading: false,
      projectsError: false,
      refetchProjects: jest.fn(),
      setSelectedProjectId: jest.fn(),
    });

    let currentSettings = {
      events: {
        epicAssigned: {
          template: '[Epic Assignment]\nInitial Template',
        },
      },
      terminal: { scrollbackLines: 10000 },
    };

    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url === '/api/settings' && (!init || !init.method || init.method === 'GET')) {
        return {
          ok: true,
          json: async () => currentSettings,
        } as Response;
      }

      if (url.startsWith('/api/preflight')) {
        return {
          ok: true,
          json: async () => ({
            overall: 'pass',
            checks: [],
            providers: [],
            timestamp: new Date().toISOString(),
          }),
        } as Response;
      }

      if (url === '/api/events' || url === '/api/prompts') {
        return {
          ok: true,
          json: async () => ({ items: [], total: 0, limit: 0, offset: 0 }),
        } as Response;
      }

      if (url === '/api/settings' && init?.method === 'PUT') {
        const payload = init.body ? JSON.parse(init.body.toString()) : {};
        currentSettings = { ...currentSettings, ...payload };
        return {
          ok: true,
          json: async () => currentSettings,
        } as Response;
      }

      return {
        ok: true,
        json: async () => ({}),
      } as Response;
    });

    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    fetchMock.mockReset();
    toastSpy.mockReset();
  });

  it('edits and saves the epic assigned template', async () => {
    const { Wrapper } = createWrapper();

    await act(async () => {
      render(
        <Wrapper>
          <SettingsPage />
        </Wrapper>,
      );
    });

    const textarea = await screen.findByLabelText(/Epic Assigned message/i);
    await waitFor(() => expect(textarea).toHaveValue('[Epic Assignment]\nInitial Template'));

    fireEvent.change(textarea, { target: { value: 'Updated template' } });
    const saveButton = (await screen.findAllByRole('button', { name: /^Save$/i })).find((button) =>
      button.parentElement?.textContent?.includes('Reset to default'),
    );
    expect(saveButton).toBeDefined();
    fireEvent.click(saveButton!);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/settings', expect.anything()));
    const putCalls = fetchMock.mock.calls.filter(
      ([, init]) => init && (init as RequestInit).method === 'PUT',
    );
    const payloads = putCalls.map(([, init]) => JSON.parse((init as RequestInit).body as string));
    const body = payloads.find((payload) => 'events' in payload) ?? ({} as Record<string, unknown>);
    expect(body.events?.epicAssigned?.template).toBe('Updated template');
    expect(toastSpy).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Epic assignment message updated' }),
    );
  });
});

describe('SettingsPage terminal streaming settings', () => {
  const originalFetch = global.fetch;
  const fetchMock = jest.fn();

  beforeEach(() => {
    useSelectedProjectMock.mockReturnValue({
      selectedProjectId: null,
      selectedProject: null,
      projects: [],
      projectsLoading: false,
      projectsError: false,
      refetchProjects: jest.fn(),
      setSelectedProjectId: jest.fn(),
    });

    let currentSettings = {
      terminal: {
        scrollbackLines: 8000,
        seedingMaxBytes: 1024 * 1024,
      },
    };

    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url === '/api/settings' && (!init || !init.method || init.method === 'GET')) {
        return {
          ok: true,
          json: async () => currentSettings,
        } as Response;
      }

      if (url.startsWith('/api/preflight')) {
        return {
          ok: true,
          json: async () => ({
            overall: 'pass',
            checks: [],
            providers: [],
            timestamp: new Date().toISOString(),
          }),
        } as Response;
      }

      if (url === '/api/settings' && init?.method === 'PUT') {
        const payload = init.body ? JSON.parse(init.body.toString()) : {};
        currentSettings = { ...currentSettings, ...payload };
        return {
          ok: true,
          json: async () => currentSettings,
        } as Response;
      }

      return {
        ok: true,
        json: async () => ({}),
      } as Response;
    });

    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    fetchMock.mockReset();
    toastSpy.mockReset();
  });

  it('updates scrollback lines and seed max bytes', async () => {
    const { Wrapper } = createWrapper();

    await act(async () => {
      render(
        <Wrapper>
          <SettingsPage />
        </Wrapper>,
      );
    });

    // Note: seed mode selector removed (tmux-based seeding is now implicit)
    // Wait for settings to load and populate the inputs
    const scrollbackInput = await screen.findByLabelText(/Scrollback lines/i);
    await waitFor(() => expect(scrollbackInput).toHaveValue(8000));

    fireEvent.change(scrollbackInput, { target: { value: '12000' } });

    const seedMaxInput = await screen.findByLabelText(/Seed snapshot cap/i);
    await waitFor(() => expect(seedMaxInput).toHaveValue(1024));
    fireEvent.change(seedMaxInput, { target: { value: '2048' } });

    const saveButton = seedMaxInput.parentElement?.parentElement?.querySelector('button');
    expect(saveButton).not.toBeNull();
    fireEvent.click(saveButton!);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/settings', expect.anything()));
    const putCall = fetchMock.mock.calls.find(
      ([input, init]) =>
        input === '/api/settings' && init && (init as RequestInit).method === 'PUT',
    );
    expect(putCall).toBeDefined();
    const body = JSON.parse((putCall?.[1] as RequestInit).body as string);
    expect(body.terminal.scrollbackLines).toBe(12000);
    expect(body.terminal.seedingMaxBytes).toBe(2048 * 1024);
    expect(toastSpy).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Terminal settings updated' }),
    );
  });
});

describe('SettingsPage preflight MCP provider rendering', () => {
  const originalFetch = global.fetch;
  const fetchMock = jest.fn();

  beforeEach(() => {
    useSelectedProjectMock.mockReturnValue({
      selectedProjectId: null,
      selectedProject: null,
      projects: [],
      projectsLoading: false,
      projectsError: false,
      refetchProjects: jest.fn(),
      setSelectedProjectId: jest.fn(),
    });

    let currentPreflight = {
      overall: 'warn',
      checks: [],
      providers: [
        {
          id: 'p1',
          name: 'codex',
          status: 'warn',
          message: 'MCP check completed without success signal (expected 1).',
          details: 'stdout: 0',
          binPath: '/usr/bin/codex',
          binaryStatus: 'pass',
          binaryMessage: 'codex binary available at /usr/bin/codex',
          mcpStatus: 'warn',
          mcpMessage: 'MCP check completed without success signal (expected 1).',
          mcpDetails: 'stdout: 0',
          mcpEndpoint: 'ws://127.0.0.1:3000/mcp',
        },
      ],
      timestamp: new Date().toISOString(),
    } as const;

    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url === '/api/settings' && (!init || !init.method || init.method === 'GET')) {
        return {
          ok: true,
          json: async () => ({}),
        } as Response;
      }

      if (url.startsWith('/api/preflight')) {
        return {
          ok: true,
          json: async () => currentPreflight,
        } as Response;
      }

      if (url === '/api/prompts') {
        return {
          ok: true,
          json: async () => ({ items: [], total: 0, limit: 0, offset: 0 }),
        } as Response;
      }

      return {
        ok: true,
        json: async () => ({}),
      } as Response;
    });

    global.fetch = fetchMock as unknown as typeof fetch;

    // Allow test to switch preflight result later
    (global as unknown as { __setPreflight?: (p: unknown) => void }).__setPreflight = (p) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      currentPreflight = p as unknown as typeof currentPreflight;
    };
  });

  afterEach(() => {
    global.fetch = originalFetch;
    fetchMock.mockReset();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as unknown as { __setPreflight?: unknown }).__setPreflight = undefined;
  });

  it('renders MCP status and details, and updates on refresh', async () => {
    const { Wrapper } = createWrapper();

    await act(async () => {
      render(
        <Wrapper>
          <SettingsPage />
        </Wrapper>,
      );
    });

    // Shows MCP WARN initially
    expect(await screen.findByText(/MCP WARN/i)).toBeInTheDocument();
    expect(screen.getByText(/MCP check completed without success signal/i)).toBeInTheDocument();
    // Details suppressed; no raw stdout shown

    // Switch to PASS and click Refresh
    (global as unknown as { __setPreflight?: (p: unknown) => void }).__setPreflight?.({
      overall: 'pass',
      checks: [],
      providers: [
        {
          id: 'p1',
          name: 'codex',
          status: 'pass',
          message: 'All good',
          details: '',
          binPath: '/usr/bin/codex',
          binaryStatus: 'pass',
          binaryMessage: 'codex binary available at /usr/bin/codex',
          mcpStatus: 'pass',
          mcpMessage: 'MCP check passed.',
          mcpDetails: '1',
          mcpEndpoint: 'ws://127.0.0.1:3000/mcp',
        },
      ],
      timestamp: new Date().toISOString(),
    });

    const refresh = await screen.findByRole('button', { name: /Refresh/i });
    await act(async () => {
      fireEvent.click(refresh);
    });

    await waitFor(() => expect(screen.getByText(/MCP PASS/i)).toBeInTheDocument());
    expect(screen.getByText(/MCP check passed\./i)).toBeInTheDocument();
  });
});

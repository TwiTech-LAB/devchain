import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ScopeSection } from './ScopeSection';
import type { ScopeConfigResponse } from '@/ui/hooks/useScopeConfig';
import type { FolderScopeEntry } from '@/modules/codebase-overview-analyzer/types/scope.types';
import { SessionApiError } from '@/ui/lib/sessions';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock('@/ui/hooks/use-toast', () => ({
  useToast: () => ({ toast: mockToast }),
}));
const mockToast = jest.fn();

const mockUseScopeConfig = jest.fn();
const mockUseSaveScopeConfig = jest.fn();

jest.mock('@/ui/hooks/useScopeConfig', () => ({
  useScopeConfig: (...args: unknown[]) => mockUseScopeConfig(...args),
  scopeQueryKeys: { config: (id: string) => ['codebase-overview', id, 'scope'] },
}));

jest.mock('@/ui/hooks/useSaveScopeConfig', () => ({
  useSaveScopeConfig: (...args: unknown[]) => mockUseSaveScopeConfig(...args),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createWrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { Wrapper };
}

const defaultEntries: FolderScopeEntry[] = [
  { folder: 'node_modules', purpose: 'excluded', reason: 'DevChain default', origin: 'default' },
  { folder: 'src', purpose: 'source', reason: 'Auto-detected', origin: 'default' },
  { folder: 'dist', purpose: 'generated', reason: 'User override', origin: 'user' },
];

const mockScopeData: ScopeConfigResponse = {
  entries: defaultEntries,
  storageMode: 'local-only',
};

function buildMutateStub(overrides: { isPending?: boolean } = {}) {
  return {
    mutate: jest.fn(),
    isPending: overrides.isPending ?? false,
    isSuccess: false,
    isError: false,
    error: null,
  };
}

function setupDefaultMocks() {
  mockUseScopeConfig.mockReturnValue({
    data: mockScopeData,
    isPending: false,
    isError: false,
  });
  mockUseSaveScopeConfig.mockReturnValue(buildMutateStub());
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ScopeSection', () => {
  beforeEach(() => {
    mockToast.mockClear();
    mockUseScopeConfig.mockReset();
    mockUseSaveScopeConfig.mockReset();
  });

  // -------------------------------------------------------------------------
  // Loading + error states
  // -------------------------------------------------------------------------

  it('shows loading skeleton while data is pending', () => {
    mockUseScopeConfig.mockReturnValue({ data: undefined, isPending: true, isError: false });
    mockUseSaveScopeConfig.mockReturnValue(buildMutateStub());
    const { Wrapper } = createWrapper();

    render(<ScopeSection projectId="p1" />, { wrapper: Wrapper });

    expect(screen.getAllByTestId('skeleton-card').length).toBeGreaterThan(0);
  });

  it('shows error empty state when query fails', () => {
    mockUseScopeConfig.mockReturnValue({ data: undefined, isPending: false, isError: true });
    mockUseSaveScopeConfig.mockReturnValue(buildMutateStub());
    const { Wrapper } = createWrapper();

    render(<ScopeSection projectId="p1" />, { wrapper: Wrapper });

    expect(screen.getByText("Couldn't load scope config")).toBeInTheDocument();
  });

  it('shows no-folders empty state when entries are empty', () => {
    mockUseScopeConfig.mockReturnValue({
      data: { entries: [], storageMode: 'local-only' },
      isPending: false,
      isError: false,
    });
    mockUseSaveScopeConfig.mockReturnValue(buildMutateStub());
    const { Wrapper } = createWrapper();

    render(<ScopeSection projectId="p1" />, { wrapper: Wrapper });

    expect(screen.getByText('No folders detected')).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // Table rendering
  // -------------------------------------------------------------------------

  it('renders 3-column table with folder, detected role, and override columns', () => {
    setupDefaultMocks();
    const { Wrapper } = createWrapper();

    render(<ScopeSection projectId="p1" />, { wrapper: Wrapper });

    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByText('Folder')).toBeInTheDocument();
    expect(screen.getByText('Detected role')).toBeInTheDocument();
    expect(screen.getByText('Override')).toBeInTheDocument();
  });

  it('renders all entries as table rows', () => {
    setupDefaultMocks();
    const { Wrapper } = createWrapper();

    render(<ScopeSection projectId="p1" />, { wrapper: Wrapper });

    expect(screen.getByText('node_modules')).toBeInTheDocument();
    expect(screen.getByText('src')).toBeInTheDocument();
    expect(screen.getByText('dist')).toBeInTheDocument();
  });

  it('shows detected role and reason in second column', () => {
    setupDefaultMocks();
    const { Wrapper } = createWrapper();

    render(<ScopeSection projectId="p1" />, { wrapper: Wrapper });

    expect(screen.getByText('Excluded — DevChain default')).toBeInTheDocument();
    expect(screen.getByText('Source — Auto-detected')).toBeInTheDocument();
  });

  it('shows (auto) label for default-origin entries in override dropdown', () => {
    setupDefaultMocks();
    const { Wrapper } = createWrapper();

    render(<ScopeSection projectId="p1" />, { wrapper: Wrapper });

    // node_modules and src are default-origin, so they show (auto)
    const autoLabels = screen.getAllByText(/\(auto\)/);
    expect(autoLabels.length).toBeGreaterThanOrEqual(2);
  });

  it('shows the overridden purpose label for user-origin entries', () => {
    setupDefaultMocks();
    const { Wrapper } = createWrapper();

    render(<ScopeSection projectId="p1" />, { wrapper: Wrapper });

    // dist has origin: 'user' and purpose: 'generated'
    const triggers = screen.getAllByRole('combobox');
    const distTrigger = triggers.find((t) => t.getAttribute('aria-label')?.includes('dist'));
    expect(distTrigger).toBeInTheDocument();
  });

  it('shows reset button only for user-override rows', () => {
    setupDefaultMocks();
    const { Wrapper } = createWrapper();

    render(<ScopeSection projectId="p1" />, { wrapper: Wrapper });

    // Only 'dist' is user-origin, so only one reset button
    const resetButtons = screen.getAllByRole('button', { name: /reset.*to auto/i });
    expect(resetButtons).toHaveLength(1);
    expect(resetButtons[0]).toHaveAccessibleName(/dist/i);
  });

  // -------------------------------------------------------------------------
  // Storage-mode banner
  // -------------------------------------------------------------------------

  it('shows repo-file storage banner when storageMode is repo-file', () => {
    mockUseScopeConfig.mockReturnValue({
      data: { entries: defaultEntries, storageMode: 'repo-file' },
      isPending: false,
      isError: false,
    });
    mockUseSaveScopeConfig.mockReturnValue(buildMutateStub());
    const { Wrapper } = createWrapper();

    render(<ScopeSection projectId="p1" />, { wrapper: Wrapper });

    const banner = screen.getByTestId('storage-mode-banner');
    expect(banner).toBeInTheDocument();
    expect(banner).toHaveTextContent('.devchain/overview.json');
    expect(banner).toHaveTextContent('Reading scope from');
  });

  it('shows local-only storage banner when storageMode is local-only', () => {
    mockUseScopeConfig.mockReturnValue({
      data: { entries: defaultEntries, storageMode: 'local-only' },
      isPending: false,
      isError: false,
    });
    mockUseSaveScopeConfig.mockReturnValue(buildMutateStub());
    const { Wrapper } = createWrapper();

    render(<ScopeSection projectId="p1" />, { wrapper: Wrapper });

    const banner = screen.getByTestId('storage-mode-banner');
    expect(banner).toBeInTheDocument();
    expect(banner).toHaveTextContent('Local-only mode');
    expect(banner).toHaveTextContent('Settings are stored locally');
  });

  it('storage banner is not dismissible (no close button)', () => {
    mockUseScopeConfig.mockReturnValue({
      data: { entries: defaultEntries, storageMode: 'repo-file' },
      isPending: false,
      isError: false,
    });
    mockUseSaveScopeConfig.mockReturnValue(buildMutateStub());
    const { Wrapper } = createWrapper();

    render(<ScopeSection projectId="p1" />, { wrapper: Wrapper });

    const banner = screen.getByTestId('storage-mode-banner');
    expect(banner.querySelector('button')).toBeNull();
  });

  it('shows storage banner in empty-state (no entries)', () => {
    mockUseScopeConfig.mockReturnValue({
      data: { entries: [], storageMode: 'local-only' },
      isPending: false,
      isError: false,
    });
    mockUseSaveScopeConfig.mockReturnValue(buildMutateStub());
    const { Wrapper } = createWrapper();

    render(<ScopeSection projectId="p1" />, { wrapper: Wrapper });

    expect(screen.getByTestId('storage-mode-banner')).toBeInTheDocument();
    expect(screen.getByText('No folders detected')).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // Touch-target accessibility (40px standard)
  // -------------------------------------------------------------------------

  describe('touch-target accessibility', () => {
    it('Select trigger has 40px height class', () => {
      setupDefaultMocks();
      const { Wrapper } = createWrapper();
      render(<ScopeSection projectId="p1" />, { wrapper: Wrapper });

      const triggers = screen.getAllByRole('combobox');
      triggers.forEach((trigger) => {
        expect(trigger).toHaveClass('h-10');
      });
    });

    it('Select trigger has focus-visible ring classes', () => {
      setupDefaultMocks();
      const { Wrapper } = createWrapper();
      render(<ScopeSection projectId="p1" />, { wrapper: Wrapper });

      const triggers = screen.getAllByRole('combobox');
      triggers.forEach((trigger) => {
        expect(trigger.className).toContain('focus-visible:ring-2');
        expect(trigger.className).toContain('focus-visible:ring-ring');
      });
    });

    it('reset-to-auto button has 40x40 size classes', () => {
      setupDefaultMocks(); // dist entry has origin:'user' → reset button is visible
      const { Wrapper } = createWrapper();
      render(<ScopeSection projectId="p1" />, { wrapper: Wrapper });

      const resetBtn = screen.getByRole('button', { name: /reset dist to auto/i });
      expect(resetBtn).toHaveClass('h-10', 'w-10');
    });

    it('reset-to-auto button has focus-visible ring classes', () => {
      setupDefaultMocks();
      const { Wrapper } = createWrapper();
      render(<ScopeSection projectId="p1" />, { wrapper: Wrapper });

      const resetBtn = screen.getByRole('button', { name: /reset dist to auto/i });
      expect(resetBtn.className).toContain('focus-visible:ring-2');
      expect(resetBtn.className).toContain('focus-visible:ring-ring');
    });
  });

  // -------------------------------------------------------------------------
  // Save button state
  // -------------------------------------------------------------------------

  it('disables Save button when no changes are pending', () => {
    setupDefaultMocks();
    const { Wrapper } = createWrapper();

    render(<ScopeSection projectId="p1" />, { wrapper: Wrapper });

    expect(screen.getByRole('button', { name: /save & re-analyze/i })).toBeDisabled();
  });

  it('disables Save button while mutation is pending', () => {
    mockUseScopeConfig.mockReturnValue({ data: mockScopeData, isPending: false, isError: false });
    mockUseSaveScopeConfig.mockReturnValue(buildMutateStub({ isPending: true }));
    const { Wrapper } = createWrapper();

    render(<ScopeSection projectId="p1" />, { wrapper: Wrapper });

    expect(screen.getByRole('button', { name: /saving…/i })).toBeDisabled();
  });

  // -------------------------------------------------------------------------
  // Dropdown interaction & dirty state
  // -------------------------------------------------------------------------

  it('enables Save button after dropdown change', async () => {
    const user = userEvent.setup();
    setupDefaultMocks();
    const { Wrapper } = createWrapper();

    render(<ScopeSection projectId="p1" />, { wrapper: Wrapper });

    // Open the select for 'src' (currently auto/source) and pick Excluded
    const srcTrigger = screen
      .getAllByRole('combobox')
      .find((t) => t.getAttribute('aria-label')?.includes('src'));
    expect(srcTrigger).toBeInTheDocument();

    await user.click(srcTrigger!);
    const excludedOption = await screen.findByRole('option', { name: 'Excluded' });
    await user.click(excludedOption);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /save & re-analyze/i })).not.toBeDisabled();
    });
  });

  it('calls mutation with entries including updated override', async () => {
    const user = userEvent.setup();
    const mutate = jest.fn();
    mockUseScopeConfig.mockReturnValue({ data: mockScopeData, isPending: false, isError: false });
    mockUseSaveScopeConfig.mockReturnValue({ ...buildMutateStub(), mutate });
    const { Wrapper } = createWrapper();

    render(<ScopeSection projectId="p1" />, { wrapper: Wrapper });

    // Change src purpose to Excluded
    const srcTrigger = screen
      .getAllByRole('combobox')
      .find((t) => t.getAttribute('aria-label')?.includes('src'));
    await user.click(srcTrigger!);
    await user.click(await screen.findByRole('option', { name: 'Excluded' }));

    fireEvent.click(screen.getByRole('button', { name: /save & re-analyze/i }));

    expect(mutate).toHaveBeenCalled();
    const [entriesArg] = mutate.mock.calls[0] as [FolderScopeEntry[]];
    expect(entriesArg).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // Reset to auto
  // -------------------------------------------------------------------------

  it('reset-to-auto reverts a local change and disables save when back to original state', async () => {
    const user = userEvent.setup();
    // All entries start as default-origin so save is initially disabled
    const allDefaultData: ScopeConfigResponse = {
      entries: [{ folder: 'src', purpose: 'source', reason: 'Auto-detected', origin: 'default' }],
      storageMode: 'local-only',
    };
    mockUseScopeConfig.mockReturnValue({ data: allDefaultData, isPending: false, isError: false });
    mockUseSaveScopeConfig.mockReturnValue(buildMutateStub());
    const { Wrapper } = createWrapper();

    render(<ScopeSection projectId="p1" />, { wrapper: Wrapper });

    // Save is disabled initially
    expect(screen.getByRole('button', { name: /save & re-analyze/i })).toBeDisabled();

    // Change src to Excluded → reset button appears, save enabled
    const srcTrigger = screen
      .getAllByRole('combobox')
      .find((t) => t.getAttribute('aria-label')?.includes('src'));
    await user.click(srcTrigger!);
    await user.click(await screen.findByRole('option', { name: 'Excluded' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /save & re-analyze/i })).not.toBeDisabled();
    });
    expect(screen.getByRole('button', { name: /reset src to auto/i })).toBeInTheDocument();

    // Click reset → reverts to original, save disabled again
    await user.click(screen.getByRole('button', { name: /reset src to auto/i }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /save & re-analyze/i })).toBeDisabled();
    });
    expect(screen.queryByRole('button', { name: /reset src to auto/i })).not.toBeInTheDocument();
  });

  it('reset-to-auto on existing user override keeps save enabled (removal is a change)', async () => {
    const user = userEvent.setup();
    setupDefaultMocks();
    const { Wrapper } = createWrapper();

    render(<ScopeSection projectId="p1" />, { wrapper: Wrapper });

    // dist is already origin: 'user' from API — reset clears the override (a change)
    const resetBtn = screen.getByRole('button', { name: /reset dist to auto/i });
    await user.click(resetBtn);

    // Save remains enabled because removing an existing user override IS a change
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /save & re-analyze/i })).not.toBeDisabled();
    });
    // Reset button disappears (now origin is 'default')
    expect(screen.queryByRole('button', { name: /reset dist to auto/i })).not.toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // Permission-denied banner
  // -------------------------------------------------------------------------

  it('shows permission-denied banner when mutation returns 422', async () => {
    const user = userEvent.setup();

    const permError = new SessionApiError('Permission denied writing scope', 422, {
      statusCode: 422,
      code: 'http_exception',
      message: 'Permission denied writing scope',
      details: {
        code: 'PERMISSION_DENIED',
        manualEditPath: '/repo/.devchain/overview.json',
      },
      timestamp: new Date().toISOString(),
      path: '/api/projects/p1/codebase-overview/scope',
    });

    let capturedOnError: ((e: SessionApiError) => void) | undefined;
    const mutate = jest.fn((_entries, opts: { onError: (e: SessionApiError) => void }) => {
      capturedOnError = opts?.onError;
    });

    mockUseScopeConfig.mockReturnValue({ data: mockScopeData, isPending: false, isError: false });
    mockUseSaveScopeConfig.mockReturnValue({ ...buildMutateStub(), mutate });
    const { Wrapper } = createWrapper();

    render(<ScopeSection projectId="p1" />, { wrapper: Wrapper });

    // Make a change to enable save
    const srcTrigger = screen
      .getAllByRole('combobox')
      .find((t) => t.getAttribute('aria-label')?.includes('src'));
    await user.click(srcTrigger!);
    await user.click(await screen.findByRole('option', { name: 'Excluded' }));

    fireEvent.click(screen.getByRole('button', { name: /save & re-analyze/i }));

    // Trigger the error callback
    await act(async () => {
      capturedOnError?.(permError);
    });

    expect(screen.getByTestId('permission-denied-banner')).toBeInTheDocument();
    expect(screen.getByText('Permission denied writing scope')).toBeInTheDocument();
    expect(screen.getByText('/repo/.devchain/overview.json')).toBeInTheDocument();
  });

  it('shows success toast on save success', async () => {
    const user = userEvent.setup();

    let capturedOnSuccess: (() => void) | undefined;
    const mutate = jest.fn((_entries, opts: { onSuccess: () => void }) => {
      capturedOnSuccess = opts?.onSuccess;
    });

    mockUseScopeConfig.mockReturnValue({ data: mockScopeData, isPending: false, isError: false });
    mockUseSaveScopeConfig.mockReturnValue({ ...buildMutateStub(), mutate });
    const { Wrapper } = createWrapper();

    render(<ScopeSection projectId="p1" />, { wrapper: Wrapper });

    const srcTrigger = screen
      .getAllByRole('combobox')
      .find((t) => t.getAttribute('aria-label')?.includes('src'));
    await user.click(srcTrigger!);
    await user.click(await screen.findByRole('option', { name: 'Excluded' }));

    fireEvent.click(screen.getByRole('button', { name: /save & re-analyze/i }));

    await act(async () => {
      capturedOnSuccess?.();
    });

    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Scope saved. Re-analyzing…' }),
    );
  });
});

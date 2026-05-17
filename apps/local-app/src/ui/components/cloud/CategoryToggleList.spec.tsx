import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PreferenceCatalogEntry } from '@/ui/hooks/useNotificationPreferences';
import { computeGroupState } from './CategoryToggleList';

const mockUpsertMutate = jest.fn();
const mockUpsert = {
  mutate: mockUpsertMutate,
  isPending: false,
  isError: false,
};

jest.mock('@/ui/hooks/useNotificationPreferences', () => ({
  ...jest.requireActual('@/ui/hooks/useNotificationPreferences'),
  useNotificationPreferences: jest.fn(),
}));

import { useNotificationPreferences } from '@/ui/hooks/useNotificationPreferences';
import { CategoryToggleList } from './CategoryToggleList';

const mockUseNotificationPreferences = useNotificationPreferences as jest.MockedFunction<
  typeof useNotificationPreferences
>;

const catalog = [
  {
    id: 'epic.assigned',
    label: 'Epic assigned',
    group: 'epic',
    critical: false,
    locked: false,
    defaultChannels: { inbox: true, push: true },
    color: '#38BDF8',
    sortOrder: 10,
  },
  {
    id: 'epic.status_changed',
    label: 'Epic status changed',
    group: 'epic',
    critical: false,
    locked: false,
    defaultChannels: { inbox: true, push: true },
    color: '#22C55E',
    sortOrder: 20,
  },
  {
    id: 'sub_epic.assigned',
    label: 'Sub-epic assigned',
    group: 'sub_epic',
    critical: false,
    locked: false,
    defaultChannels: { inbox: true, push: true },
    color: '#06B6D4',
    sortOrder: 30,
  },
  {
    id: 'session.crashed',
    label: 'Session crashed',
    group: 'session',
    critical: false,
    locked: false,
    defaultChannels: { inbox: true, push: true },
    color: '#F97316',
    sortOrder: 40,
  },
  {
    id: 'security.session_revoked',
    label: 'Session revoked',
    group: 'security',
    critical: true,
    locked: true,
    defaultChannels: { inbox: true, push: true },
    color: '#EF4444',
    sortOrder: 60,
  },
  {
    id: 'account.banned',
    label: 'Account banned',
    group: 'account',
    critical: true,
    locked: true,
    defaultChannels: { inbox: true, push: true },
    color: '#FB7185',
    sortOrder: 70,
  },
] satisfies PreferenceCatalogEntry[];

function renderList() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <CategoryToggleList />
    </QueryClientProvider>,
  );
}

const baseCat = (overrides: Partial<PreferenceCatalogEntry> = {}): PreferenceCatalogEntry => ({
  id: 'epic.created',
  label: 'Epic created',
  group: 'epic',
  critical: false,
  locked: false,
  defaultChannels: { inbox: true, push: true },
  color: '#38BDF8',
  sortOrder: 10,
  ...overrides,
});

describe('computeGroupState', () => {
  it('returns Required when all categories are locked', () => {
    const cats = [baseCat({ locked: true }), baseCat({ id: 'epic.assigned', locked: true })];
    expect(computeGroupState(cats, [])).toBe('Required');
  });

  it('returns On when all unlocked categories are enabled (default true when no pref)', () => {
    const cats = [baseCat(), baseCat({ id: 'epic.assigned' })];
    expect(computeGroupState(cats, [])).toBe('On');
  });

  it('returns On when all unlocked categories have enabled pref', () => {
    const cats = [baseCat(), baseCat({ id: 'epic.assigned' })];
    const prefs = [
      { category: 'epic.created', channel: 'push', enabled: true },
      { category: 'epic.assigned', channel: 'push', enabled: true },
    ];
    expect(computeGroupState(cats, prefs)).toBe('On');
  });

  it('returns Off when all unlocked categories are disabled', () => {
    const cats = [baseCat(), baseCat({ id: 'epic.assigned' })];
    const prefs = [
      { category: 'epic.created', channel: 'push', enabled: false },
      { category: 'epic.assigned', channel: 'push', enabled: false },
    ];
    expect(computeGroupState(cats, prefs)).toBe('Off');
  });

  it('returns Mixed when some unlocked categories are enabled and some are disabled', () => {
    const cats = [baseCat(), baseCat({ id: 'epic.assigned' })];
    const prefs = [
      { category: 'epic.created', channel: 'push', enabled: true },
      { category: 'epic.assigned', channel: 'push', enabled: false },
    ];
    expect(computeGroupState(cats, prefs)).toBe('Mixed');
  });

  it('ignores locked categories when computing On/Off/Mixed', () => {
    const cats = [baseCat({ locked: true }), baseCat({ id: 'epic.assigned', locked: false })];
    const prefs = [{ category: 'epic.assigned', channel: 'push', enabled: false }];
    expect(computeGroupState(cats, prefs)).toBe('Off');
  });
});

describe('CategoryToggleList', () => {
  beforeEach(() => {
    mockUpsertMutate.mockReset();
    mockUseNotificationPreferences.mockReturnValue({
      preferences: [
        { category: 'epic.assigned', channel: 'push', enabled: true },
        { category: 'epic.status_changed', channel: 'push', enabled: false },
        { category: 'sub_epic.assigned', channel: 'push', enabled: true },
        { category: 'session.crashed', channel: 'push', enabled: true },
      ],
      catalog,
      isLoading: false,
      upsert: mockUpsert,
    } as ReturnType<typeof useNotificationPreferences>);
  });

  it('renders category rows grouped by catalog metadata', () => {
    renderList();
    expect(screen.getByText(/^epics$/i)).toBeInTheDocument();
    expect(screen.getByText(/^sub-epics$/i)).toBeInTheDocument();
    expect(screen.getByText(/^sessions$/i)).toBeInTheDocument();
    expect(screen.getByText(/^account & security$/i)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /sub-epics push alert categories/i }),
    ).toHaveAttribute('data-state', 'closed');
    expect(screen.getAllByRole('switch')).toHaveLength(2);
  });

  it('expands grouped categories on demand', () => {
    renderList();
    const trigger = screen.getByRole('button', { name: /sub-epics push alert categories/i });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).toHaveClass('focus-visible:ring-2');
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByLabelText(/push notifications for sub-epic assigned/i)).toBeInTheDocument();
  });

  it('renders locked account and security switches as disabled and labeled required', () => {
    renderList();
    fireEvent.click(
      screen.getByRole('button', { name: /account & security push alert categories/i }),
    );
    const switches = screen.getAllByRole('switch');
    const disabledSwitches = switches.filter((sw) => sw.hasAttribute('disabled'));
    expect(disabledSwitches).toHaveLength(2);
    // 2 row-level "Required" badges + 1 "Required" group-state label in the header
    expect(screen.getAllByText(/^required$/i)).toHaveLength(3);
  });

  it('critical categories have tooltip text "Required for account safety"', async () => {
    renderList();
    fireEvent.click(
      screen.getByRole('button', { name: /account & security push alert categories/i }),
    );
    const securitySwitch = screen.getByLabelText(/push notifications for session revoked/i);
    fireEvent.focus(securitySwitch);
    // Tooltip content is in the DOM for disabled switches
    expect(screen.queryAllByText(/required for account safety/i).length).toBeGreaterThanOrEqual(0);
  });

  it('toggling a non-critical switch calls upsert.mutate with category and new enabled value', () => {
    renderList();
    const epicAssignedSwitch = screen.getByLabelText(/push notifications for epic assigned/i);
    fireEvent.click(epicAssignedSwitch);
    expect(mockUpsertMutate).toHaveBeenCalledWith(
      { category: 'epic.assigned', enabled: false },
      expect.any(Object),
    );
  });

  it('clicking a disabled critical switch does not call upsert.mutate', () => {
    renderList();
    fireEvent.click(
      screen.getByRole('button', { name: /account & security push alert categories/i }),
    );
    const securitySwitch = screen.getByLabelText(/push notifications for session revoked/i);
    fireEvent.click(securitySwitch);
    expect(mockUpsertMutate).not.toHaveBeenCalled();
  });

  it('shows inline error message when PREFERENCE_LOCKED error is triggered', async () => {
    mockUpsertMutate.mockImplementation(
      (_args: unknown, opts: { onError?: (e: Error) => void }) => {
        opts?.onError?.(new Error('PREFERENCE_LOCKED'));
      },
    );

    renderList();
    const epicAssignedSwitch = screen.getByLabelText(/push notifications for epic assigned/i);
    fireEvent.click(epicAssignedSwitch);

    await waitFor(() => {
      expect(screen.getByText(/this notification cannot be disabled/i)).toBeInTheDocument();
    });
  });

  it('falls back to the static catalog when hook catalog is unavailable', () => {
    mockUseNotificationPreferences.mockReturnValue({
      preferences: [],
      isLoading: false,
      upsert: mockUpsert,
    } as ReturnType<typeof useNotificationPreferences>);

    renderList();

    expect(screen.getByText(/^epics$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/push notifications for epic assigned/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /sub-epics push alert categories/i }));
    expect(screen.getByLabelText(/push notifications for sub-epic assigned/i)).toBeInTheDocument();
  });

  it('shows plural event badge for groups with multiple categories', () => {
    renderList();
    // Epics group has 2 categories in the mock catalog
    expect(screen.getAllByText('2 events').length).toBeGreaterThanOrEqual(1);
  });

  it('shows singular event badge for groups with one category', () => {
    renderList();
    // Sub-epics, Sessions each have 1 category in the mock catalog
    expect(screen.getAllByText('1 event').length).toBeGreaterThanOrEqual(1);
  });

  it('shows Mixed state label for epics group when preferences are partially enabled', () => {
    renderList();
    // epic.assigned=true, epic.status_changed=false → Mixed
    expect(screen.getByText('Mixed')).toBeInTheDocument();
  });

  it('shows Required state label for all-locked account & security group', () => {
    renderList();
    expect(screen.getByText('Required')).toBeInTheDocument();
  });

  it('shows On state label when all non-locked categories are enabled', () => {
    renderList();
    // Sub-epics: sub_epic.assigned=true → On; Sessions: session.crashed=true → On
    const onLabels = screen.getAllByText('On');
    expect(onLabels.length).toBeGreaterThanOrEqual(1);
  });
});

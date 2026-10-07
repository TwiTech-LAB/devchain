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
  it.each([
    {
      label: 'all locked are required',
      cats: [baseCat({ locked: true }), baseCat({ id: 'epic.assigned', locked: true })],
      prefs: [],
      expected: 'Required',
    },
    {
      label: 'unconfigured unlocked categories default on',
      cats: [baseCat(), baseCat({ id: 'epic.assigned' })],
      prefs: [],
      expected: 'On',
    },
    {
      label: 'locked categories do not affect unlocked off state',
      cats: [baseCat({ locked: true }), baseCat({ id: 'epic.assigned', locked: false })],
      prefs: [{ category: 'epic.assigned', channel: 'push', enabled: false }],
      expected: 'Off',
    },
  ] as const)('$label', ({ cats, prefs, expected }) => {
    expect(computeGroupState([...cats], [...prefs])).toBe(expected);
  });

  it.each([
    {
      label: 'returns On when all unlocked categories have enabled pref',
      firstEnabled: true,
      secondEnabled: true,
      expectedState: 'On',
    },
    {
      label: 'returns Off when all unlocked categories are disabled',
      firstEnabled: false,
      secondEnabled: false,
      expectedState: 'Off',
    },
    {
      label: 'returns Mixed when some unlocked categories are enabled and some are disabled',
      firstEnabled: true,
      secondEnabled: false,
      expectedState: 'Mixed',
    },
  ] as const)('$label', ({ firstEnabled, secondEnabled, expectedState }) => {
    const cats = [baseCat(), baseCat({ id: 'epic.assigned' })];
    const prefs = [
      { category: 'epic.created', channel: 'push', enabled: firstEnabled },
      { category: 'epic.assigned', channel: 'push', enabled: secondEnabled },
    ];
    expect(computeGroupState(cats, prefs)).toBe(expectedState);
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
    } as unknown as ReturnType<typeof useNotificationPreferences>);
  });

  it('shows catalog groups, category counts and aggregate preference states', () => {
    renderList();
    {
      expect(screen.getByText(/^epics$/i)).toBeInTheDocument();
      expect(screen.getByText(/^sub-epics$/i)).toBeInTheDocument();
      expect(screen.getByText(/^sessions$/i)).toBeInTheDocument();
      expect(screen.getByText(/^account & security$/i)).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: /sub-epics push alert categories/i }),
      ).toHaveAttribute('data-state', 'closed');
      expect(screen.getAllByRole('switch')).toHaveLength(2);
    }
    {
      expect(screen.getAllByText('2 events').length).toBeGreaterThanOrEqual(1);
    }
    {
      expect(screen.getAllByText('1 event').length).toBeGreaterThanOrEqual(1);
    }
    {
      expect(screen.getByText('Mixed')).toBeInTheDocument();
    }
    {
      expect(screen.getByText('Required')).toBeInTheDocument();
    }
    {
      const onLabels = screen.getAllByText('On');
      expect(onLabels.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('expands grouped categories on demand', () => {
    renderList();
    const trigger = screen.getByRole('button', { name: /sub-epics push alert categories/i });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');

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

  it('toggling a non-critical switch calls upsert.mutate with category and new enabled value', () => {
    renderList();
    const epicAssignedSwitch = screen.getByLabelText(/push notifications for epic assigned/i);
    fireEvent.click(epicAssignedSwitch);
    expect(mockUpsertMutate).toHaveBeenCalledWith(
      { category: 'epic.assigned', enabled: false },
      expect.any(Object),
    );
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
    } as unknown as ReturnType<typeof useNotificationPreferences>);

    renderList();

    expect(screen.getByText(/^epics$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/push notifications for epic assigned/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /sub-epics push alert categories/i }));
    expect(screen.getByLabelText(/push notifications for sub-epic assigned/i)).toBeInTheDocument();
  });
});

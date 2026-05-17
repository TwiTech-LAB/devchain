import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

export interface Preference {
  category: string;
  channel: string;
  enabled: boolean;
}

export type NotificationCatalogGroup =
  | 'epic'
  | 'sub_epic'
  | 'session'
  | 'security'
  | 'account'
  | 'other';

export interface PreferenceCatalogEntry {
  id: string;
  label: string;
  group: NotificationCatalogGroup;
  critical: boolean;
  locked: boolean;
  defaultChannels: { inbox: boolean; push: boolean };
  color: string;
  sortOrder: number;
}

interface PreferencesData {
  preferences: Preference[];
}

interface PreferencesCatalogData {
  version: string;
  categories: PreferenceCatalogEntry[];
}

interface UpsertArgs {
  category: string;
  enabled: boolean;
}

export const STATIC_NOTIFICATION_CATALOG: PreferenceCatalogEntry[] = [
  {
    id: 'epic.created',
    label: 'Epic created',
    group: 'epic',
    critical: false,
    locked: false,
    defaultChannels: { inbox: true, push: true },
    color: '#38BDF8',
    sortOrder: 10,
  },
  {
    id: 'epic.assigned',
    label: 'Epic assigned',
    group: 'epic',
    critical: false,
    locked: false,
    defaultChannels: { inbox: true, push: true },
    color: '#38BDF8',
    sortOrder: 20,
  },
  {
    id: 'epic.status_changed',
    label: 'Epic status changed',
    group: 'epic',
    critical: false,
    locked: false,
    defaultChannels: { inbox: true, push: true },
    color: '#22C55E',
    sortOrder: 30,
  },
  {
    id: 'epic.comment',
    label: 'Epic comment',
    group: 'epic',
    critical: false,
    locked: false,
    defaultChannels: { inbox: true, push: true },
    color: '#0EA5E9',
    sortOrder: 40,
  },
  {
    id: 'epic.deleted',
    label: 'Epic deleted',
    group: 'epic',
    critical: false,
    locked: false,
    defaultChannels: { inbox: true, push: true },
    color: '#0284C7',
    sortOrder: 50,
  },
  {
    id: 'sub_epic.created',
    label: 'Sub-epic created',
    group: 'sub_epic',
    critical: false,
    locked: false,
    defaultChannels: { inbox: true, push: true },
    color: '#06B6D4',
    sortOrder: 60,
  },
  {
    id: 'sub_epic.assigned',
    label: 'Sub-epic assigned',
    group: 'sub_epic',
    critical: false,
    locked: false,
    defaultChannels: { inbox: true, push: true },
    color: '#06B6D4',
    sortOrder: 70,
  },
  {
    id: 'sub_epic.status_changed',
    label: 'Sub-epic status changed',
    group: 'sub_epic',
    critical: false,
    locked: false,
    defaultChannels: { inbox: true, push: true },
    color: '#14B8A6',
    sortOrder: 80,
  },
  {
    id: 'sub_epic.comment',
    label: 'Sub-epic comment',
    group: 'sub_epic',
    critical: false,
    locked: false,
    defaultChannels: { inbox: true, push: true },
    color: '#0891B2',
    sortOrder: 90,
  },
  {
    id: 'sub_epic.deleted',
    label: 'Sub-epic deleted',
    group: 'sub_epic',
    critical: false,
    locked: false,
    defaultChannels: { inbox: true, push: true },
    color: '#0E7490',
    sortOrder: 100,
  },
  {
    id: 'session.crashed',
    label: 'Session crashed',
    group: 'session',
    critical: false,
    locked: false,
    defaultChannels: { inbox: true, push: true },
    color: '#F97316',
    sortOrder: 110,
  },
  {
    id: 'session.stopped',
    label: 'Session stopped',
    group: 'session',
    critical: false,
    locked: false,
    defaultChannels: { inbox: true, push: true },
    color: '#F59E0B',
    sortOrder: 120,
  },
  {
    id: 'security.session_revoked',
    label: 'Session revoked',
    group: 'security',
    critical: true,
    locked: true,
    defaultChannels: { inbox: true, push: true },
    color: '#EF4444',
    sortOrder: 150,
  },
  {
    id: 'account.banned',
    label: 'Account banned',
    group: 'account',
    critical: true,
    locked: true,
    defaultChannels: { inbox: true, push: true },
    color: '#FB7185',
    sortOrder: 160,
  },
  {
    id: 'account.deletion_requested',
    label: 'Deletion requested',
    group: 'account',
    critical: true,
    locked: true,
    defaultChannels: { inbox: true, push: true },
    color: '#F43F5E',
    sortOrder: 170,
  },
];

function toRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function isCatalogGroup(value: unknown): value is NotificationCatalogGroup {
  return (
    value === 'epic' ||
    value === 'sub_epic' ||
    value === 'session' ||
    value === 'security' ||
    value === 'account' ||
    value === 'other'
  );
}

function isCatalogEntry(value: unknown): value is PreferenceCatalogEntry {
  const entry = toRecord(value);
  const defaultChannels = toRecord(entry?.defaultChannels);

  return (
    entry !== null &&
    typeof entry.id === 'string' &&
    typeof entry.label === 'string' &&
    isCatalogGroup(entry.group) &&
    typeof entry.critical === 'boolean' &&
    typeof entry.locked === 'boolean' &&
    defaultChannels !== null &&
    typeof defaultChannels.inbox === 'boolean' &&
    typeof defaultChannels.push === 'boolean' &&
    typeof entry.color === 'string' &&
    typeof entry.sortOrder === 'number'
  );
}

function parseCatalogData(value: unknown): PreferencesCatalogData | null {
  const payload = toRecord(value);
  if (!payload || !Array.isArray(payload.categories)) return null;

  const categories = payload.categories.filter(isCatalogEntry);
  if (categories.length === 0) return null;

  return {
    version: typeof payload.version === 'string' ? payload.version : 'unknown',
    categories,
  };
}

function labelFromCategoryId(category: string): string {
  return category
    .replaceAll('_', ' ')
    .split('.')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function inferGroup(category: string): NotificationCatalogGroup {
  if (category.startsWith('epic.')) return 'epic';
  if (category.startsWith('sub_epic.')) return 'sub_epic';
  if (category.startsWith('session.')) return 'session';
  if (category.startsWith('security.')) return 'security';
  if (category.startsWith('account.')) return 'account';
  return 'other';
}

function withPreferenceFallbacks(
  catalog: PreferenceCatalogEntry[],
  preferences: Preference[],
): PreferenceCatalogEntry[] {
  const known = new Set(catalog.map((entry) => entry.id));
  const fallbackEntries: PreferenceCatalogEntry[] = [];

  for (const preference of preferences) {
    if (preference.channel !== 'push' || known.has(preference.category)) continue;
    if (preference.category.startsWith('review.')) continue;
    known.add(preference.category);
    const locked =
      preference.category.startsWith('security.') || preference.category.startsWith('account.');

    fallbackEntries.push({
      id: preference.category,
      label: labelFromCategoryId(preference.category),
      group: inferGroup(preference.category),
      critical: locked,
      locked,
      defaultChannels: { inbox: true, push: true },
      color: '#64748B',
      sortOrder: 900 + fallbackEntries.length,
    });
  }

  return [...catalog, ...fallbackEntries];
}

export function useNotificationPreferences() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery<PreferencesData>({
    queryKey: ['cloud', 'preferences'],
    queryFn: async () => {
      const res = await fetch('/api/cloud/preferences');
      if (!res.ok) throw new Error(`preferences:${res.status}`);
      return res.json();
    },
    staleTime: 30_000,
  });

  const catalogQuery = useQuery<PreferencesCatalogData>({
    queryKey: ['cloud', 'preferences', 'catalog'],
    queryFn: async () => {
      const res = await fetch('/api/cloud/preferences/catalog');
      if (!res.ok) {
        return { version: 'static', categories: STATIC_NOTIFICATION_CATALOG };
      }
      const parsed = parseCatalogData(await res.json());
      return parsed ?? { version: 'static', categories: STATIC_NOTIFICATION_CATALOG };
    },
    staleTime: 5 * 60_000,
  });

  const upsert = useMutation({
    mutationFn: async (args: UpsertArgs) => {
      const res = await fetch(
        `/api/cloud/preferences/categories/${encodeURIComponent(args.category)}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ channel: 'push', enabled: args.enabled }),
        },
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(
          (err as { code?: string }).code === 'PREFERENCE_LOCKED'
            ? 'PREFERENCE_LOCKED'
            : `upsert:${res.status}`,
        );
      }
    },
    onMutate: async (args) => {
      await queryClient.cancelQueries({ queryKey: ['cloud', 'preferences'] });
      const previous = queryClient.getQueryData<PreferencesData>(['cloud', 'preferences']);
      queryClient.setQueryData<PreferencesData>(['cloud', 'preferences'], (old) => {
        if (!old) return old;
        const exists = old.preferences.some(
          (p) => p.category === args.category && p.channel === 'push',
        );
        const updated = exists
          ? old.preferences.map((p) =>
              p.category === args.category && p.channel === 'push'
                ? { ...p, enabled: args.enabled }
                : p,
            )
          : [
              ...old.preferences,
              { category: args.category, channel: 'push', enabled: args.enabled },
            ];
        return { preferences: updated };
      });
      return { previous };
    },
    onError: (_err, _args, ctx) => {
      if (ctx?.previous !== undefined) {
        queryClient.setQueryData(['cloud', 'preferences'], ctx.previous);
      }
    },
  });

  const preferences = data?.preferences ?? [];
  const catalog = withPreferenceFallbacks(
    catalogQuery.data?.categories ?? STATIC_NOTIFICATION_CATALOG,
    preferences,
  );

  return { preferences, catalog, isLoading: isLoading || catalogQuery.isLoading, upsert };
}

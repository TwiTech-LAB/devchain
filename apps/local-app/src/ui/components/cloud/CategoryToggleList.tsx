import React from 'react';
import { ChevronRight } from 'lucide-react';
import { Switch } from '../ui/switch';
import { Badge } from '../ui/badge';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip';
import {
  STATIC_NOTIFICATION_CATALOG,
  type NotificationCatalogGroup,
  type PreferenceCatalogEntry,
  type Preference,
  useNotificationPreferences,
} from '@/ui/hooks/useNotificationPreferences';
import { cn } from '@/ui/lib/utils';

export type GroupState = 'Required' | 'On' | 'Off' | 'Mixed';

export function computeGroupState(
  categories: PreferenceCatalogEntry[],
  preferences: Preference[],
): GroupState {
  if (categories.every((cat) => cat.locked)) return 'Required';
  const unlocked = categories.filter((cat) => !cat.locked);
  const enabledCount = unlocked.filter((cat) => {
    const pref = preferences.find((p) => p.category === cat.id && p.channel === 'push');
    return pref?.enabled ?? true;
  }).length;
  if (enabledCount === unlocked.length) return 'On';
  if (enabledCount === 0) return 'Off';
  return 'Mixed';
}

type CategoryDisplayGroupKey = 'epic' | 'sub_epic' | 'session' | 'account_security' | 'other';

const GROUPS: Array<{
  key: CategoryDisplayGroupKey;
  label: string;
  description?: string;
}> = [
  { key: 'epic', label: 'Epics' },
  { key: 'sub_epic', label: 'Sub-epics' },
  { key: 'session', label: 'Sessions' },
  {
    key: 'account_security',
    label: 'Account & Security',
    description: 'Required for account safety',
  },
  { key: 'other', label: 'Other' },
];

interface CategoryRowProps {
  category: PreferenceCatalogEntry;
  label: string;
  enabled: boolean;
  locked: boolean;
  onToggle: (categoryId: string, checked: boolean) => void;
  lockedError?: boolean;
}

function CategoryRow({
  category,
  label,
  enabled,
  locked,
  onToggle,
  lockedError,
}: CategoryRowProps) {
  const sw = (
    <Switch
      checked={enabled}
      disabled={locked}
      onCheckedChange={(checked) => !locked && onToggle(category.id, checked)}
      aria-label={`Push notifications for ${label}`}
    />
  );

  return (
    <div className="flex flex-col py-2">
      <div className="flex items-center justify-between">
        <span className="flex min-w-0 items-center gap-2 text-sm">
          <span
            aria-hidden="true"
            className="h-2.5 w-2.5 shrink-0 rounded-full"
            style={{ backgroundColor: category.color }}
          />
          <span className="truncate">{label}</span>
          {locked && (
            <span className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] font-medium uppercase text-muted-foreground">
              Required
            </span>
          )}
        </span>
        {locked ? (
          <Tooltip>
            <TooltipTrigger asChild>{sw}</TooltipTrigger>
            <TooltipContent>Required for account safety</TooltipContent>
          </Tooltip>
        ) : (
          sw
        )}
      </div>
      {lockedError && (
        <p className="text-xs text-destructive mt-1">This notification cannot be disabled.</p>
      )}
    </div>
  );
}

function getDisplayGroup(categoryGroup: NotificationCatalogGroup): CategoryDisplayGroupKey {
  if (categoryGroup === 'security' || categoryGroup === 'account') return 'account_security';
  return categoryGroup;
}

function groupCatalog(catalog: PreferenceCatalogEntry[]) {
  const pushCatalog = catalog
    .filter((category) => category.defaultChannels.push && !category.id.startsWith('review.'))
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));

  return GROUPS.map((group) => ({
    ...group,
    categories: pushCatalog.filter((category) => getDisplayGroup(category.group) === group.key),
  })).filter((group) => group.categories.length > 0);
}

export function CategoryToggleList() {
  const {
    preferences,
    catalog = STATIC_NOTIFICATION_CATALOG,
    upsert,
  } = useNotificationPreferences();
  const [lockedErrors, setLockedErrors] = React.useState<Record<string, boolean>>({});
  const groups = React.useMemo(() => groupCatalog(catalog), [catalog]);

  function getEnabled(category: PreferenceCatalogEntry): boolean {
    if (category.locked) return true;
    const pref = preferences.find((p) => p.category === category.id && p.channel === 'push');
    return pref?.enabled ?? true;
  }

  function handleToggle(categoryId: string, checked: boolean) {
    upsert.mutate(
      { category: categoryId, enabled: checked },
      {
        onError: (err) => {
          if (err.message === 'PREFERENCE_LOCKED') {
            setLockedErrors((prev) => ({ ...prev, [categoryId]: true }));
            setTimeout(() => setLockedErrors((prev) => ({ ...prev, [categoryId]: false })), 4000);
          }
        },
      },
    );
  }

  return (
    <TooltipProvider delayDuration={300}>
      <div className="space-y-2">
        {groups.map((group) => {
          const n = group.categories.length;
          const state = computeGroupState(group.categories, preferences);
          return (
            <Collapsible
              key={group.key}
              defaultOpen={group.key === 'epic'}
              className="rounded-lg border bg-card"
            >
              <CollapsibleTrigger
                className="group flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={`${group.label} push alert categories`}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <ChevronRight
                    className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90"
                    aria-hidden="true"
                  />
                  <span className="min-w-0">
                    <span
                      id={`notification-category-group-${group.key}`}
                      className="block truncate text-sm font-medium"
                    >
                      {group.label}
                    </span>
                    {group.description && (
                      <span className="block truncate text-xs text-muted-foreground">
                        {group.description}
                      </span>
                    )}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <Badge variant="secondary" className="text-xs">
                    {n} {n === 1 ? 'event' : 'events'}
                  </Badge>
                  <span className="text-xs text-muted-foreground">{state}</span>
                </span>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <section
                  aria-labelledby={`notification-category-group-${group.key}`}
                  className={cn('border-t px-3 py-1', group.description && 'pt-2')}
                >
                  <div className="divide-y">
                    {group.categories.map((cat) => (
                      <CategoryRow
                        key={cat.id}
                        category={cat}
                        label={cat.label}
                        enabled={getEnabled(cat)}
                        locked={cat.locked}
                        onToggle={handleToggle}
                        lockedError={lockedErrors[cat.id]}
                      />
                    ))}
                  </div>
                </section>
              </CollapsibleContent>
            </Collapsible>
          );
        })}
      </div>
    </TooltipProvider>
  );
}

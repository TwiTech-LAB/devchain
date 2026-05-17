import type { LucideIcon } from 'lucide-react';
import { Cloud, User, Bell } from 'lucide-react';
import { PageHeader } from '@/ui/components/shared';
import { useSubNavSearchParam } from '@/ui/hooks/useSubNavSearchParam';
import { cn } from '@/ui/lib/utils';
import { AccountSection } from './cloud/AccountSection';
import { NotificationsSection } from './cloud/NotificationsSection';

const SECTION_KEYS = ['account', 'notifications'] as const;
type SectionKey = (typeof SECTION_KEYS)[number];

const NAV_ITEMS: { key: SectionKey; label: string; icon: LucideIcon }[] = [
  { key: 'account', label: 'Account', icon: User },
  { key: 'notifications', label: 'Notifications', icon: Bell },
];

export function CloudPage() {
  const [activeSection, setActiveSection] = useSubNavSearchParam(
    [...SECTION_KEYS],
    'account',
    'section',
  );

  return (
    <div className="flex flex-col lg:flex-row h-full">
      <nav
        className={cn(
          'flex flex-col shrink-0 lg:w-56',
          'border-b lg:border-b-0 lg:border-r border-border bg-card',
        )}
        aria-label="Cloud navigation"
      >
        <div className="flex items-center gap-2 px-4 py-3">
          <Cloud className="h-5 w-5 text-primary" />
          <span className="text-sm font-semibold text-foreground">Cloud</span>
        </div>
        <div className="flex flex-row lg:flex-col" role="tablist" aria-label="Cloud sections">
          {NAV_ITEMS.map(({ key, label, icon: Icon }) => {
            const isSelected = activeSection === key;
            return (
              <button
                key={key}
                id={`cloud-tab-${key}`}
                type="button"
                role="tab"
                aria-selected={isSelected}
                aria-controls="cloud-tabpanel"
                onClick={() => setActiveSection(key)}
                className={cn(
                  'flex items-center gap-2 px-4 py-2.5 text-sm font-medium text-left',
                  'transition-colors outline-none',
                  'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
                  isSelected
                    ? 'bg-primary/10 text-primary lg:border-r-2 lg:border-r-primary'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
              >
                <Icon className="h-4 w-4 shrink-0" />
                {label}
              </button>
            );
          })}
        </div>
      </nav>

      <div
        id="cloud-tabpanel"
        role="tabpanel"
        aria-labelledby={`cloud-tab-${activeSection}`}
        className="flex-1 min-w-0 overflow-y-auto pt-4 lg:pt-0 lg:pl-6"
      >
        <PageHeader
          title="Cloud Settings"
          description="Manage your DevChain Cloud account, notification delivery, and project forwarding."
          className="mb-6"
        />
        {activeSection === 'account' && <AccountSection />}
        {activeSection === 'notifications' && (
          <NotificationsSection onNavigateToAccount={() => setActiveSection('account')} />
        )}
      </div>
    </div>
  );
}

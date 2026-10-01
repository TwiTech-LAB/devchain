import type { LucideIcon } from 'lucide-react';
import { Cloud, User, Bell, Server } from 'lucide-react';
import { useSubNavSearchParam } from '@/ui/hooks/useSubNavSearchParam';
import { cn } from '@/ui/lib/utils';
import { AccountSection } from './cloud/AccountSection';
import { RemoteVmSection } from './cloud/RemoteVmSection';
import { NotificationsSection } from './cloud/NotificationsSection';

const SECTION_KEYS = ['account', 'remote-vm', 'notifications'] as const;
type SectionKey = (typeof SECTION_KEYS)[number];

const NAV_ITEMS: { key: SectionKey; label: string; icon: LucideIcon }[] = [
  { key: 'account', label: 'Account', icon: User },
  { key: 'remote-vm', label: 'Remote VMs', icon: Server },
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
          'flex flex-col shrink-0 lg:w-72',
          'rounded-xl border border-border bg-card shadow-sm',
        )}
        aria-label="Cloud navigation"
      >
        <div className="flex items-center gap-2 px-4 py-4">
          <Cloud className="h-6 w-6 text-primary" />
          <span className="text-base font-bold text-foreground">Cloud</span>
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
                  'relative flex items-center gap-2 px-4 py-3 text-sm font-medium text-left',
                  'transition-colors outline-none',
                  'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
                  isSelected
                    ? 'bg-primary/10 text-primary lg:after:absolute lg:after:right-0 lg:after:top-2 lg:after:bottom-2 lg:after:w-0.5 lg:after:rounded-full lg:after:bg-primary lg:after:pointer-events-none'
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
        {activeSection === 'account' && <AccountSection />}
        {activeSection === 'remote-vm' && <RemoteVmSection />}
        {activeSection === 'notifications' && (
          <NotificationsSection onNavigateToAccount={() => setActiveSection('account')} />
        )}
      </div>
    </div>
  );
}

import { Settings, Terminal, MessageSquare, Sparkles, Bell, Shield } from 'lucide-react';
import { PageHeader, SubNavLayout } from '@/ui/components/shared';
import type { SubNavSection } from '@/ui/components/shared';
import { useSubNavSearchParam } from '@/ui/hooks/useSubNavSearchParam';
import { GeneralSection } from './settings/GeneralSection';
import { TerminalSection } from './settings/TerminalSection';
import { MessagingSection } from './settings/MessagingSection';
import { SkillsSection } from './settings/SkillsSection';
import { EventsSection } from './settings/EventsSection';
import { SystemSection } from './settings/SystemSection';

const SECTION_KEYS = ['general', 'terminal', 'messaging', 'skills', 'events', 'system'] as const;
type SectionKey = (typeof SECTION_KEYS)[number];

const SETTINGS_SECTIONS: SubNavSection<SectionKey>[] = [
  { key: 'general', label: 'General', icon: Settings, render: () => <GeneralSection /> },
  { key: 'terminal', label: 'Terminal', icon: Terminal, render: () => <TerminalSection /> },
  { key: 'messaging', label: 'Messaging', icon: MessageSquare, render: () => <MessagingSection /> },
  { key: 'skills', label: 'Skills', icon: Sparkles, render: () => <SkillsSection /> },
  { key: 'events', label: 'Events', icon: Bell, render: () => <EventsSection /> },
  { key: 'system', label: 'System', icon: Shield, render: () => <SystemSection /> },
];

export function SettingsPage() {
  const [activeSection, setActiveSection] = useSubNavSearchParam(
    [...SECTION_KEYS],
    'general',
    'section',
  );

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title="Settings"
        description="Configure system settings and provider binaries"
        className="mb-6"
      />
      <SubNavLayout<SectionKey>
        sections={SETTINGS_SECTIONS}
        activeKey={activeSection}
        onSelect={setActiveSection}
        ariaLabel="Settings navigation"
      />
    </div>
  );
}

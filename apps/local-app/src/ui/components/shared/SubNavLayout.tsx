import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/ui/components/ui/tabs';
import { cn } from '@/ui/lib/utils';

export interface SubNavSection<K extends string = string> {
  key: K;
  label: string;
  icon?: LucideIcon;
  render: () => ReactNode;
}

interface SubNavLayoutProps<K extends string> {
  sections: SubNavSection<K>[];
  activeKey: K;
  onSelect: (key: K) => void;
  ariaLabel?: string;
}

export function SubNavLayout<K extends string>({
  sections,
  activeKey,
  onSelect,
  ariaLabel = 'Sub navigation',
}: SubNavLayoutProps<K>) {
  return (
    <Tabs
      value={activeKey}
      onValueChange={(value) => onSelect(value as K)}
      orientation="vertical"
      className="flex flex-col lg:flex-row h-full"
    >
      {/* Left rail — vertical nav items; stacks above content on mobile */}
      <TabsList
        className={cn(
          'flex flex-col shrink-0 lg:w-72',
          'h-auto items-stretch justify-start rounded-none p-0',
          'border-b lg:border-b-0 lg:border-r border-border bg-card',
        )}
        aria-label={ariaLabel}
      >
        {sections.map((section) => {
          const Icon = section.icon;
          return (
            <TabsTrigger
              key={section.key}
              value={section.key}
              className={cn(
                'flex items-center gap-2 justify-start rounded-none shadow-none',
                'px-4 py-2.5 text-sm font-medium',
                'text-muted-foreground hover:bg-muted hover:text-foreground',
                'data-[state=active]:bg-muted data-[state=active]:text-foreground data-[state=active]:shadow-none',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
              )}
            >
              {Icon && <Icon className="h-4 w-4 shrink-0" />}
              {section.label}
            </TabsTrigger>
          );
        })}
      </TabsList>

      {/* Content panel */}
      {sections.map((section) => (
        <TabsContent
          key={section.key}
          value={section.key}
          className="flex-1 mt-0 overflow-y-auto focus-visible:ring-0 focus-visible:ring-offset-0"
        >
          {section.render()}
        </TabsContent>
      ))}
    </Tabs>
  );
}

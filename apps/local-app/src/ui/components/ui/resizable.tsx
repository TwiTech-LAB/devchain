import * as React from 'react';
import { GripVertical } from 'lucide-react';
import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels';
import { cn } from '@/ui/lib/utils';

export { useDefaultLayout };

const ResizablePanelGroup = ({ className, ...props }: React.ComponentProps<typeof Group>) => (
  <Group
    className={cn('flex h-full w-full data-[panel-group-direction=vertical]:flex-col', className)}
    {...props}
  />
);

const ResizablePanel = Panel;

const ResizableHandle = ({
  withHandle,
  className,
  ...props
}: React.ComponentProps<typeof Separator> & {
  withHandle?: boolean;
}) => (
  <Separator
    className={cn(
      // Base styles for vertical handle (horizontal panel group)
      // w-2 = 8px hit area, bg-transparent with after:bg-border for thin visual line
      'relative flex w-2 items-center justify-center bg-transparent after:absolute after:inset-y-0 after:left-1/2 after:w-px after:bg-border after:-translate-x-1/2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1',
      // Horizontal handle styles (vertical panel group) - uses aria-orientation
      // h-2 = 8px hit area for reliable dragging, after:top-1/2 centers the line
      'aria-[orientation=horizontal]:h-2 aria-[orientation=horizontal]:w-full aria-[orientation=horizontal]:after:inset-y-auto aria-[orientation=horizontal]:after:top-1/2 aria-[orientation=horizontal]:after:left-0 aria-[orientation=horizontal]:after:h-px aria-[orientation=horizontal]:after:w-full aria-[orientation=horizontal]:after:-translate-y-1/2 aria-[orientation=horizontal]:after:translate-x-0 [&[aria-orientation=horizontal]>div]:rotate-90',
      className,
    )}
    {...props}
  >
    {withHandle && (
      <div className="z-10 flex h-4 w-3 items-center justify-center rounded-sm border bg-border">
        <GripVertical className="h-2.5 w-2.5" />
      </div>
    )}
  </Separator>
);

export { ResizablePanelGroup, ResizablePanel, ResizableHandle };

import { Switch } from '@/ui/components/ui/switch';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/ui/components/ui/tooltip';

export const ALWAYS_ON_REASON = 'Built-in DevChain skills are always on';

/** A switch locked on, for sources and skills the server refuses to disable. */
export function AlwaysOnSwitch({ label }: { label: string }) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex">
            <Switch checked disabled aria-label={label} />
          </span>
        </TooltipTrigger>
        <TooltipContent>{ALWAYS_ON_REASON}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

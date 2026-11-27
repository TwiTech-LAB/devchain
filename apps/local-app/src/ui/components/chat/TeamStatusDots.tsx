import { memo, useCallback, type MouseEvent } from 'react';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/ui/components/ui/tooltip';
import type { AgentPresenceMap } from '@/ui/lib/sessions';
import { cn } from '@/ui/lib/utils';
import {
  DOT_STATE_WORDS,
  describeDot,
  getTeamDots,
  summarizeTeamDots,
  type DotState,
} from './team-status-dots';

interface TeamStatusDotsProps {
  teamName: string;
  /** Team agents in row order. */
  agents: Array<{ id: string; name: string; disabled?: boolean }>;
  leadAgentId: string | null;
  agentPresence: AgentPresenceMap;
  onSelectAgent: (agentId: string) => void;
}

/**
 * 6px, the size and slow pulse of the live dot in the terminal header (InlineSessionSummaryChip).
 * Idle is a darker green that does not pulse. "waiting" is a diamond so it differs from green
 * by shape, not colour only.
 */
const DOT_CLASSES: Record<DotState, string> = {
  waiting: 'h-[5px] w-[5px] rotate-45 rounded-[1px] bg-status-warn',
  working: 'h-1.5 w-1.5 rounded-full bg-status-ok animate-activity-pulse',
  idle: 'h-1.5 w-1.5 rounded-full bg-status-ok brightness-[0.6]',
  offline: 'h-1.5 w-1.5 rounded-full border border-muted-foreground/60',
};

function TeamStatusDotsInner({
  teamName,
  agents,
  leadAgentId,
  agentPresence,
  onSelectAgent,
}: TeamStatusDotsProps) {
  const handleClick = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      // The header around the dots may toggle the fold; a dot only selects its agent.
      event.stopPropagation();
      const agentId = event.currentTarget.dataset.agentId;
      if (agentId) onSelectAgent(agentId);
    },
    [onSelectAgent],
  );

  const dots = getTeamDots(agents, leadAgentId, agentPresence);
  if (dots.length === 0) return null;
  const now = Date.now();

  return (
    <TooltipProvider delayDuration={300}>
      {/* Room for six 16px dots per line keeps a full team (11 dots) within two lines; the
          team name gives way first. */}
      <div
        role="group"
        aria-label={summarizeTeamDots(teamName, dots)}
        className="flex min-w-[6rem] flex-1 flex-wrap items-center"
        data-testid="team-status-dots"
      >
        {dots.map((dot) => (
          <Tooltip key={dot.agentId}>
            <TooltipTrigger asChild>
              <button
                type="button"
                data-agent-id={dot.agentId}
                data-state={dot.state}
                onClick={handleClick}
                aria-label={`${dot.agentName}, ${DOT_STATE_WORDS[dot.state]}`}
                className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <span aria-hidden="true" className={cn('block', DOT_CLASSES[dot.state])} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" className="text-xs">
              {`${dot.agentName} · ${describeDot(dot, now)}`}
            </TooltipContent>
          </Tooltip>
        ))}
      </div>
    </TooltipProvider>
  );
}

export const TeamStatusDots = memo(TeamStatusDotsInner);

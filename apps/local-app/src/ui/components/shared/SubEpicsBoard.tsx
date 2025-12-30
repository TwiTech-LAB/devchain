import { useMemo } from 'react';
import { Trash2, User } from 'lucide-react';
import { cn } from '@/ui/lib/utils';
import { Button } from '@/ui/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/components/ui/select';
import { EpicTooltipWrapper } from './EpicTooltipWrapper';

// Helper to determine if a hex color is light (returns true) or dark (returns false)
function isLightColor(hex: string): boolean {
  const color = hex.replace('#', '');
  const r = parseInt(color.substring(0, 2), 16);
  const g = parseInt(color.substring(2, 4), 16);
  const b = parseInt(color.substring(4, 6), 16);
  // Using relative luminance formula
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.5;
}

export interface SubEpic {
  id: string;
  title: string;
  statusId: string;
  // Optional fields for tooltip preview and assignment
  description?: string | null;
  agentId?: string | null;
  agentName?: string | null;
}

export interface Status {
  id: string;
  label: string;
  color: string;
  position: number;
}

export interface Agent {
  id: string;
  name: string;
}

export interface SubEpicsBoardProps {
  subEpics: SubEpic[];
  statuses: Status[];
  agents?: Agent[];
  onSubEpicClick?: (subEpicId: string) => void;
  onDeleteSubEpic?: (subEpicId: string) => void;
  onAssignAgent?: (subEpicId: string, agentId: string | null) => void;
  className?: string;
}

export function SubEpicsBoard({
  subEpics,
  statuses,
  agents = [],
  onSubEpicClick,
  onDeleteSubEpic,
  onAssignAgent,
  className,
}: SubEpicsBoardProps) {
  // Group sub-epics by status
  const subEpicsByStatus = useMemo(() => {
    const grouped = new Map<string, SubEpic[]>();
    for (const subEpic of subEpics) {
      const existing = grouped.get(subEpic.statusId) || [];
      existing.push(subEpic);
      grouped.set(subEpic.statusId, existing);
    }
    return grouped;
  }, [subEpics]);

  // Only show statuses that have sub-epics, sorted by position
  const statusesWithSubEpics = useMemo(
    () =>
      [...statuses]
        .filter((status) => (subEpicsByStatus.get(status.id)?.length ?? 0) > 0)
        .sort((a, b) => a.position - b.position),
    [statuses, subEpicsByStatus],
  );

  if (statuses.length === 0) {
    return (
      <div className={cn('text-sm text-muted-foreground', className)}>No statuses configured.</div>
    );
  }

  if (statusesWithSubEpics.length === 0) {
    return <div className={cn('text-sm text-muted-foreground', className)}>No sub-epics yet.</div>;
  }

  return (
    <div className={cn('space-y-3', className)}>
      {statusesWithSubEpics.map((status) => {
        const groupEpics = subEpicsByStatus.get(status.id) || [];
        const count = groupEpics.length;

        return (
          <div key={status.id} className="space-y-1.5">
            {/* Status Header Row */}
            <div className="flex items-center gap-2">
              <div
                className="rounded-full flex-shrink-0 flex items-center justify-center font-medium h-5 w-5 text-[10px]"
                style={{
                  backgroundColor: status.color,
                  color: isLightColor(status.color) ? '#1f2937' : '#ffffff',
                }}
              >
                {count}
              </div>
              <span className="text-sm font-medium">{status.label}</span>
            </div>

            {/* Sub-epics List */}
            <div className="space-y-1 pl-7">
              {groupEpics.map((subEpic) => (
                <div
                  key={subEpic.id}
                  className={cn(
                    'flex items-center gap-2 px-2 py-1.5 rounded text-sm group',
                    'bg-muted/40 hover:bg-muted transition-colors',
                  )}
                >
                  {/* Title with tooltip */}
                  <EpicTooltipWrapper
                    title={subEpic.title}
                    statusLabel={status.label}
                    statusColor={status.color}
                    agentName={subEpic.agentName}
                    description={subEpic.description}
                    delayDuration={200}
                  >
                    <button
                      type="button"
                      onClick={() => onSubEpicClick?.(subEpic.id)}
                      className="flex-1 text-left truncate hover:underline focus:outline-none focus:underline"
                    >
                      {subEpic.title}
                    </button>
                  </EpicTooltipWrapper>

                  {/* Agent Assignment Dropdown */}
                  {onAssignAgent && agents.length > 0 && (
                    <Select
                      value={subEpic.agentId ?? 'unassigned'}
                      onValueChange={(value) =>
                        onAssignAgent(subEpic.id, value === 'unassigned' ? null : value)
                      }
                    >
                      <SelectTrigger
                        className={cn(
                          'h-6 px-1.5 border-0 bg-transparent transition-opacity [&>svg:last-child]:hidden',
                          subEpic.agentId
                            ? 'w-auto opacity-70 hover:opacity-100'
                            : 'w-6 p-0 opacity-0 group-hover:opacity-100 focus:opacity-100',
                        )}
                        aria-label="Assign agent"
                      >
                        <SelectValue>
                          <span className="flex items-center gap-1 text-xs text-muted-foreground">
                            <User className="h-3.5 w-3.5 flex-shrink-0" />
                            {subEpic.agentName && (
                              <span className="truncate max-w-[80px]">{subEpic.agentName}</span>
                            )}
                          </span>
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent align="end">
                        <SelectItem value="unassigned">Unassigned</SelectItem>
                        {agents.map((agent) => (
                          <SelectItem key={agent.id} value={agent.id}>
                            {agent.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}

                  {/* Delete Button */}
                  {onDeleteSubEpic && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDeleteSubEpic(subEpic.id);
                      }}
                      className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity text-muted-foreground hover:text-destructive"
                      aria-label={`Delete ${subEpic.title}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default SubEpicsBoard;

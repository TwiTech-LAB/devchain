import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useSelectedProject } from '@/ui/hooks/useProjectSelection';
import { fetchActiveSessions, fetchAgentSummary, type ActiveSession } from '@/ui/lib/sessions';
import { cn } from '@/ui/lib/utils';
import { useFetchFactory } from '@/ui/hooks/useFetchFactory';

interface SessionSwitcherProps {
  currentSessionId: string;
  onSessionSwitch: (session: ActiveSession) => void;
}

interface SessionTabProps {
  session: ActiveSession;
  isActive: boolean;
  agentName: string | null;
  shortcutNumber: number;
  onClick: () => void;
}

function SessionTab({ session, isActive, agentName, shortcutNumber, onClick }: SessionTabProps) {
  const displayName = agentName || `Session ${session.id.slice(0, 8)}`;
  const shortcutKey = shortcutNumber <= 9 ? `Ctrl+Shift+${shortcutNumber}` : '';

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={cn(
        'flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors',
        'focus:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        isActive
          ? 'bg-selected text-selected-foreground'
          : 'bg-muted/40 text-muted-foreground hover:bg-accent hover:text-foreground',
      )}
      title={`Switch to ${displayName}${shortcutKey ? ` (${shortcutKey})` : ''}`}
    >
      <div
        className={cn(
          'h-1.5 w-1.5 rounded-full',
          session.status === 'running' ? 'bg-status-ok' : 'bg-muted-foreground',
        )}
      />
      <span className="truncate max-w-[80px]">{displayName}</span>
      {shortcutKey && <span className="text-[10px] ml-1">{shortcutNumber}</span>}
    </button>
  );
}

export function SessionSwitcher({ currentSessionId, onSessionSwitch }: SessionSwitcherProps) {
  const { selectedProjectId } = useSelectedProject();
  const apiFetch = useFetchFactory();

  // Fetch all active sessions for the current project
  const { data: activeSessions = [] } = useQuery({
    queryKey: ['active-sessions', selectedProjectId],
    queryFn: () => fetchActiveSessions(selectedProjectId!, apiFetch),
    enabled: Boolean(selectedProjectId),
    refetchInterval: 10000, // Refresh every 10 seconds
  });

  // Keyboard shortcuts for session switching
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Check for Ctrl+Shift+1-9 (avoiding browser conflicts)
      if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey) {
        // Use event.code instead of event.key to handle shifted characters
        // e.g., Ctrl+Shift+1 gives key='!' but code='Digit1'
        let numberKey: number | null = null;

        if (e.code >= 'Digit1' && e.code <= 'Digit9') {
          numberKey = parseInt(e.code.replace('Digit', ''));
        }
        // Also handle the shifted characters for backward compatibility
        else if (['!', '@', '#', '$', '%', '^', '&', '*', '('].includes(e.key)) {
          const shiftedKeys = ['!', '@', '#', '$', '%', '^', '&', '*', '('];
          const index = shiftedKeys.indexOf(e.key);
          if (index !== -1) {
            numberKey = index + 1;
          }
        }

        if (numberKey && numberKey >= 1 && numberKey <= 9) {
          e.preventDefault();
          e.stopPropagation();

          // Find session at this position (1-indexed) from current ordering
          const targetSession = activeSessions[numberKey - 1];
          if (targetSession && targetSession.id !== currentSessionId) {
            onSessionSwitch(targetSession);
          }
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => {
      document.removeEventListener('keydown', handleKeyDown, { capture: true });
    };
  }, [activeSessions, currentSessionId, onSessionSwitch]);

  // Don't show switcher if there's only one session or no project
  if (!selectedProjectId || activeSessions.length <= 1) {
    return null;
  }

  return (
    <div className="flex items-center gap-1 mx-3">
      <div className="h-4 w-px bg-border" />
      <div className="flex items-center gap-1 flex-wrap">
        {/* Debug indicator */}
        <span className="text-[10px] text-destructive mr-1">
          KB:Ctrl+Shift+1-{Math.min(activeSessions.length, 9)}
        </span>
        {activeSessions.map((session, index) => (
          <SessionTabWithAgent
            key={session.id}
            session={session}
            isActive={session.id === currentSessionId}
            shortcutNumber={index + 1}
            onSessionSwitch={onSessionSwitch}
          />
        ))}
      </div>
    </div>
  );
}

interface SessionTabWithAgentProps {
  session: ActiveSession;
  isActive: boolean;
  shortcutNumber: number;
  onSessionSwitch: (session: ActiveSession) => void;
}

function SessionTabWithAgent({
  session,
  isActive,
  shortcutNumber,
  onSessionSwitch,
}: SessionTabWithAgentProps) {
  const apiFetch = useFetchFactory();
  // Fetch agent name for this session
  const { data: agent } = useQuery({
    queryKey: ['terminal-window', 'agent', session.agentId],
    queryFn: () => fetchAgentSummary(session.agentId!, apiFetch),
    enabled: Boolean(session.agentId),
  });

  return (
    <SessionTab
      session={session}
      isActive={isActive}
      agentName={agent?.name || null}
      shortcutNumber={shortcutNumber}
      onClick={() => onSessionSwitch(session)}
    />
  );
}

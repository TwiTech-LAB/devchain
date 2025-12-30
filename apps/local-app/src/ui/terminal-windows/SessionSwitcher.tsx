import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useSelectedProject } from '@/ui/hooks/useProjectSelection';
import { fetchActiveSessions, fetchAgentSummary, type ActiveSession } from '@/ui/lib/sessions';
import { cn } from '@/ui/lib/utils';

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
        'hover:bg-muted/70 focus:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        isActive
          ? 'bg-primary text-primary-foreground'
          : 'bg-muted/40 text-muted-foreground hover:text-foreground',
      )}
      title={`Switch to ${displayName}${shortcutKey ? ` (${shortcutKey})` : ''}`}
    >
      <div
        className={cn(
          'h-1.5 w-1.5 rounded-full',
          session.status === 'running' ? 'bg-emerald-500' : 'bg-muted-foreground',
        )}
      />
      <span className="truncate max-w-[80px]">{displayName}</span>
      {shortcutKey && <span className="text-[10px] opacity-75 ml-1">{shortcutNumber}</span>}
    </button>
  );
}

export function SessionSwitcher({ currentSessionId, onSessionSwitch }: SessionSwitcherProps) {
  const { selectedProjectId } = useSelectedProject();

  // Fetch all active sessions for the current project
  const { data: activeSessions = [] } = useQuery({
    queryKey: ['active-sessions', selectedProjectId],
    queryFn: () => fetchActiveSessions(selectedProjectId!),
    enabled: Boolean(selectedProjectId),
    refetchInterval: 10000, // Refresh every 10 seconds
  });

  // Keyboard shortcuts for session switching
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      console.log('SessionSwitcher keydown:', {
        key: e.key,
        ctrlKey: e.ctrlKey,
        shiftKey: e.shiftKey,
        altKey: e.altKey,
        metaKey: e.metaKey,
        activeSessions: activeSessions.length,
        currentSessionId,
      });

      // Check for Ctrl+Shift+1-9 (avoiding browser conflicts)
      if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey) {
        console.log('SessionSwitcher: Ctrl+Shift detected');

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
          console.log('SessionSwitcher: Shifted character detection:', {
            key: e.key,
            foundIndex: index,
            calculatedNumber: index + 1,
            shiftedKeys,
          });
          if (index !== -1) {
            numberKey = index + 1;
          }
        }

        console.log('SessionSwitcher: Number key:', numberKey, 'from code:', e.code, 'key:', e.key);

        // Special debug for key 3
        if (e.key === '#' || e.code === 'Digit3') {
          console.log('SessionSwitcher: DEBUGGING Ctrl+Shift+3:', {
            key: e.key,
            code: e.code,
            detectedNumber: numberKey,
            shouldBe3: true,
          });
        }

        if (numberKey && numberKey >= 1 && numberKey <= 9) {
          console.log('SessionSwitcher: Valid number key, preventing default');
          e.preventDefault();
          e.stopPropagation();

          // Find session at this position (1-indexed) from current ordering
          const orderedSessions = activeSessions;
          const targetSession = orderedSessions[numberKey - 1];
          console.log('SessionSwitcher: Target session details:', {
            numberKey,
            arrayIndex: numberKey - 1,
            targetSessionId: targetSession?.id,
            targetSessionAgent: targetSession?.agentId,
            currentSessionId,
            totalSessions: activeSessions.length,
            allSessionIds: activeSessions.map((s) => s.id),
            isCurrentSession: targetSession?.id === currentSessionId,
          });

          if (targetSession && targetSession.id !== currentSessionId) {
            console.log('SessionSwitcher: SWITCHING to session:', targetSession.id);
            onSessionSwitch(targetSession);
          } else if (!targetSession) {
            console.log(
              'SessionSwitcher: ERROR - Target session not found at index',
              numberKey - 1,
            );
          } else if (targetSession.id === currentSessionId) {
            console.log('SessionSwitcher: SKIPPING - Already on target session:', targetSession.id);
          } else {
            console.log('SessionSwitcher: UNKNOWN - No switch performed');
          }
        }
      }
    };

    console.log('SessionSwitcher: Adding keydown listener');
    document.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => {
      console.log('SessionSwitcher: Removing keydown listener');
      document.removeEventListener('keydown', handleKeyDown, { capture: true });
    };
  }, [activeSessions, currentSessionId, onSessionSwitch]);

  console.log('SessionSwitcher render:', {
    selectedProjectId,
    activeSessionsLength: activeSessions.length,
    currentSessionId,
    currentOrder: activeSessions.map((s) => ({ id: s.id, agentId: s.agentId })),
  });

  // Don't show switcher if there's only one session or no project
  if (!selectedProjectId || activeSessions.length <= 1) {
    console.log('SessionSwitcher: Not rendering - only', activeSessions.length, 'sessions');
    return null;
  }

  console.log('SessionSwitcher: Rendering with', activeSessions.length, 'sessions');

  return (
    <div className="flex items-center gap-1 mx-3">
      <div className="h-4 w-px bg-border" />
      <div className="flex items-center gap-1 flex-wrap">
        {/* Debug indicator */}
        <span className="text-[10px] text-red-500 mr-1">
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
  // Fetch agent name for this session
  const { data: agent } = useQuery({
    queryKey: ['terminal-window', 'agent', session.agentId],
    queryFn: () => fetchAgentSummary(session.agentId!),
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

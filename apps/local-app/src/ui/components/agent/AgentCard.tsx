import { Button } from '@/ui/components/ui/button';
import { Badge } from '@/ui/components/ui/badge';
import { Avatar, AvatarFallback, AvatarImage } from '@/ui/components/ui/avatar';
import {
  TooltipProvider,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/ui/components/ui/tooltip';
import { Loader2, Play, Pencil, RotateCcw, Power } from 'lucide-react';
import {
  getAgentAvatarAltText,
  getAgentAvatarDataUri,
  getAgentInitials,
} from '@/ui/lib/multiavatar';

// ============================================
// Types
// ============================================

export interface AgentCardProviderConfig {
  id: string;
  profileId: string;
  providerId: string;
  name: string;
  options: string | null;
  env: Record<string, string> | null;
}

export interface AgentCardProfile {
  id: string;
  name: string;
  providerId: string;
  provider?: {
    id: string;
    name: string;
  };
  promptCount?: number;
}

export interface AgentCardProvider {
  id: string;
  name: string;
  binPath?: string | null;
}

export interface AgentCardData {
  id: string;
  projectId: string;
  profileId: string;
  providerConfigId?: string | null;
  name: string;
  description?: string | null;
  profile?: AgentCardProfile;
  providerConfig?: AgentCardProviderConfig;
  createdAt: string;
  updatedAt: string;
}

export interface AgentCardPresence {
  online: boolean;
  sessionId?: string;
}

export interface AgentCardProps {
  agent: AgentCardData;
  /** Resolved profile (from agent.profile or profilesById lookup) */
  profile: AgentCardProfile | undefined;
  /** Resolved provider name for display */
  providerName: string | undefined;
  /** Providers map for provider config badge title */
  providersById: Map<string, AgentCardProvider>;
  /** Presence state for this agent */
  presence: AgentCardPresence | undefined;
  /** Whether this is the last-used agent */
  isLastUsed: boolean;
  /** Whether a launch is in progress for this agent */
  isLaunching: boolean;
  /** Whether an update is in progress for this agent */
  isUpdating: boolean;
  /** Whether a delete is in progress for this agent */
  isDeleting: boolean;
  /** Whether session controls should be disabled (e.g. no project selected) */
  controlsDisabled: boolean;
  /** Whether a terminate is in progress for this agent */
  isTerminating: boolean;
  /** Whether a restart is in progress for this agent */
  isRestarting: boolean;

  // Callbacks
  onLaunch: (agentId: string) => void;
  onRestart: (agentId: string, sessionId: string) => void;
  onTerminate: (agentId: string, sessionId: string) => void;
  onEdit: (agent: AgentCardData) => void;
  onDelete: (agent: AgentCardData) => void;
}

// ============================================
// Component
// ============================================

export function AgentCard({
  agent,
  profile,
  providerName,
  providersById,
  presence,
  isLastUsed,
  isLaunching,
  isUpdating,
  isDeleting,
  controlsDisabled,
  isTerminating,
  isRestarting,
  onLaunch,
  onRestart,
  onTerminate,
  onEdit,
  onDelete,
}: AgentCardProps) {
  const avatarSrc = getAgentAvatarDataUri(agent.name);
  const avatarAlt = getAgentAvatarAltText(agent.name);
  const avatarFallback = getAgentInitials(agent.name);

  const sessionId = presence?.sessionId ?? null;
  const hasSession = Boolean(presence?.online && sessionId);
  const anyBusy = isLaunching || isTerminating || isRestarting;

  return (
    <div className="border rounded-lg p-4 bg-card" data-testid={`agent-card-${agent.id}`}>
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-1 items-start gap-3">
          <Avatar
            className="h-12 w-12 border border-border"
            aria-label={avatarAlt}
            title={avatarAlt}
          >
            {avatarSrc ? <AvatarImage src={avatarSrc} alt={avatarAlt} /> : null}
            <AvatarFallback className="uppercase tracking-wide">{avatarFallback}</AvatarFallback>
          </Avatar>
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-2">
              <h3 className="text-lg font-semibold">{agent.name || 'Unnamed agent'}</h3>
              {isLastUsed && (
                <Badge variant="secondary" className="uppercase">
                  Last launched
                </Badge>
              )}
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm text-muted-foreground">Profile:</span>
              <span className="text-sm font-medium">{profile?.name || 'Unknown Profile'}</span>
              {providerName && <Badge variant="secondary">{providerName.toUpperCase()}</Badge>}
              {agent.providerConfig && (
                <Badge
                  variant="outline"
                  title={[
                    agent.providerConfig.name,
                    providersById.get(agent.providerConfig.providerId)?.name !==
                    agent.providerConfig.name
                      ? `(${providersById.get(agent.providerConfig.providerId)?.name})`
                      : null,
                    agent.providerConfig.options,
                  ]
                    .filter(Boolean)
                    .join(' ')}
                >
                  {agent.providerConfig.name}
                  {agent.providerConfig.env &&
                    Object.keys(agent.providerConfig.env).length > 0 &&
                    ' [env]'}
                </Badge>
              )}
              {profile?.promptCount !== undefined && (
                <Badge variant="outline">
                  {profile.promptCount} prompt
                  {profile.promptCount !== 1 ? 's' : ''}
                </Badge>
              )}
            </div>
            {agent.description && (
              <p className="text-sm text-muted-foreground mt-2 line-clamp-2">{agent.description}</p>
            )}
            <p className="text-xs text-muted-foreground mt-2">
              Created {new Date(agent.createdAt).toLocaleDateString()}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {hasSession && sessionId ? (
            <>
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="sm"
                      variant="default"
                      aria-label="Restart session"
                      title="Terminate the current session and start a new one"
                      disabled={controlsDisabled || anyBusy}
                      onClick={() => onRestart(agent.id, sessionId)}
                    >
                      {anyBusy ? (
                        <>
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          Restarting…
                        </>
                      ) : (
                        <>
                          <RotateCcw className="mr-2 h-4 w-4" />
                          Restart
                        </>
                      )}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Restart session</TooltipContent>
                </Tooltip>
              </TooltipProvider>

              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="sm"
                      variant="destructive"
                      aria-label="Terminate session"
                      title="Terminate the current session"
                      disabled={controlsDisabled || isTerminating || isRestarting}
                      onClick={() => onTerminate(agent.id, sessionId)}
                    >
                      {isTerminating ? (
                        <>
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          Terminating…
                        </>
                      ) : (
                        <>
                          <Power className="mr-2 h-4 w-4" />
                          Terminate
                        </>
                      )}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Terminate session</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </>
          ) : (
            <Button
              size="sm"
              onClick={() => onLaunch(agent.id)}
              disabled={controlsDisabled || isLaunching}
              aria-label="Launch session"
              title="Launch a new session for this agent"
            >
              {isLaunching ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Launching…
                </>
              ) : (
                <>
                  <Play className="mr-2 h-4 w-4" />
                  Launch Session
                </>
              )}
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={() => onEdit(agent)} disabled={isUpdating}>
            <Pencil className="mr-2 h-4 w-4" />
            Edit
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => onDelete(agent)}
            disabled={isDeleting}
          >
            Delete
          </Button>
        </div>
      </div>
    </div>
  );
}

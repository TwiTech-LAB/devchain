import { Button } from '@/ui/components/ui/button';
import { Badge } from '@/ui/components/ui/badge';
import { Avatar, AvatarFallback, AvatarImage } from '@/ui/components/ui/avatar';
import { Pencil } from 'lucide-react';
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
  profileId?: string;
  providerId: string;
  name: string;
  options?: string | null;
  env?: Record<string, string> | null;
}

export interface AgentCardProfile {
  id: string;
  name: string;
  providerId?: string;
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
  projectId?: string;
  profileId: string | null;
  providerConfigId?: string | null;
  name: string;
  isProjectOwner: boolean;
  description?: string | null;
  profile?: AgentCardProfile;
  providerConfig?: AgentCardProviderConfig | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface AgentCardProps<TAgent extends AgentCardData = AgentCardData> {
  agent: TAgent;
  /** Resolved profile (from agent.profile or profilesById lookup) */
  profile: AgentCardProfile | undefined;
  /** Resolved provider name for display */
  providerName: string | undefined;
  /** Providers map for provider config badge title */
  providersById: Map<string, AgentCardProvider>;
  /** Whether an update is in progress for this agent */
  isUpdating: boolean;
  /** Whether a delete is in progress for this agent */
  isDeleting: boolean;

  // Callbacks
  onEdit: (agent: TAgent) => void;
  onDelete: (agent: TAgent) => void;
}

// ============================================
// Component
// ============================================

export function AgentCard<TAgent extends AgentCardData>({
  agent,
  profile,
  providerName,
  providersById,
  isUpdating,
  isDeleting,
  onEdit,
  onDelete,
}: AgentCardProps<TAgent>) {
  const avatarSrc = getAgentAvatarDataUri(agent.name);
  const avatarAlt = getAgentAvatarAltText(agent.name);
  const avatarFallback = getAgentInitials(agent.name);

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
              {agent.isProjectOwner && (
                <Badge variant="outline" aria-label="Project owner">
                  Project owner
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
            {agent.createdAt && (
              <p className="text-xs text-muted-foreground mt-2">
                Created {new Date(agent.createdAt).toLocaleDateString()}
              </p>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
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

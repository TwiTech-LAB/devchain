import { useCallback } from 'react';
import { useToast } from '@/ui/hooks/use-toast';
import { launchSession, restartSession, terminateSession } from '@/ui/lib/sessions';
import { restartKeyForWorktree } from '@/ui/lib/restart-keys';
import type { WorktreeAgentGroup } from '@/ui/hooks/useWorktreeAgents';
import {
  getMcpProviderDetails,
  isMcpNotConfigured,
  runTrackedOperation,
  useLifecyclePendingTracker,
  type LifecycleAction,
} from '@/ui/hooks/lifecycle/session-lifecycle-core';

/**
 * Worktree policy adapter (Seam 1, third consumer). Owns the lifecycle orchestration
 * that used to live inline in ChatPage (:1226-1368). Its divergences from the chat
 * and agents adapters — apiBase-targeted fetches on the module default fetch (no
 * injected `apiFetch`), a switch-tab MCP guidance toast instead of a modal, worktree
 * group refresh for cache sync, the missing-`devchainProjectId` guard, and
 * restart-key clearing — are all preserved byte-for-byte per the lifecycle matrix.
 *
 * Cache sync (`refreshWorktreeAgentGroups`) and pending-restart clearing
 * (`clearPendingRestart`) stay owned by ChatPage and are injected, because they
 * touch ChatPage-local query/state seams.
 */
export interface UseWorktreeSessionControlsOptions {
  refreshWorktreeAgentGroups: () => Promise<void>;
  clearPendingRestart: (key: string) => void;
}

export interface UseWorktreeSessionControlsResult {
  worktreeSessionActionsByAgentKey: Record<string, LifecycleAction>;
  getWorktreeAgentKey: (worktreeName: string, agentId: string) => string;
  handleLaunchWorktreeSession: (group: WorktreeAgentGroup, agentId: string) => Promise<void>;
  handleRestartWorktreeSession: (group: WorktreeAgentGroup, agentId: string) => Promise<void>;
  handleTerminateWorktreeSession: (
    group: WorktreeAgentGroup,
    agentId: string,
    sessionId: string,
  ) => Promise<void>;
}

export function useWorktreeSessionControls({
  refreshWorktreeAgentGroups,
  clearPendingRestart,
}: UseWorktreeSessionControlsOptions): UseWorktreeSessionControlsResult {
  const { toast } = useToast();
  const pending = useLifecyclePendingTracker();

  const getWorktreeAgentKey = useCallback(
    (worktreeName: string, agentId: string): string => `${worktreeName}:${agentId}`,
    [],
  );

  const showWorktreeMcpToast = useCallback(
    (providerName?: string) => {
      toast({
        title: 'MCP not configured',
        description: `Switch to worktree tab to configure MCP${providerName ? ` for ${providerName}` : ''}.`,
        variant: 'destructive',
      });
    },
    [toast],
  );

  const handleLaunchWorktreeSession = useCallback(
    async (group: WorktreeAgentGroup, agentId: string) => {
      if (!group.devchainProjectId) {
        toast({
          title: 'Worktree project unavailable',
          description: `Cannot launch session for ${group.name} because project metadata is missing.`,
          variant: 'destructive',
        });
        return;
      }

      const agentKey = getWorktreeAgentKey(group.name, agentId);
      await runTrackedOperation(pending, agentKey, 'launching', {
        run: async () => {
          await launchSession(agentId, group.devchainProjectId as string, undefined, group.apiBase);
          toast({
            title: 'Session launched',
            description: `Session started for ${group.name}:${agentId}.`,
          });
          await refreshWorktreeAgentGroups();
        },
        onError: (error) => {
          if (isMcpNotConfigured(error)) {
            showWorktreeMcpToast(getMcpProviderDetails(error).providerName);
            return;
          }
          toast({
            title: 'Failed to launch session',
            description:
              error instanceof Error ? error.message : 'Unable to launch session right now.',
            variant: 'destructive',
          });
        },
      });
    },
    [getWorktreeAgentKey, pending, refreshWorktreeAgentGroups, showWorktreeMcpToast, toast],
  );

  const handleRestartWorktreeSession = useCallback(
    async (group: WorktreeAgentGroup, agentId: string) => {
      if (!group.devchainProjectId) {
        toast({
          title: 'Worktree project unavailable',
          description: `Cannot restart session for ${group.name} because project metadata is missing.`,
          variant: 'destructive',
        });
        return;
      }

      const agentKey = getWorktreeAgentKey(group.name, agentId);
      await runTrackedOperation(pending, agentKey, 'restarting', {
        run: async () => {
          const currentSessionId = group.agentPresence[agentId]?.sessionId ?? '';
          const result = await restartSession(
            agentId,
            group.devchainProjectId as string,
            currentSessionId,
            group.apiBase,
          );
          if (result.terminateWarning) {
            toast({
              title: 'Session restarted with warning',
              description: result.terminateWarning,
              variant: 'destructive',
            });
          } else {
            toast({
              title: 'Session restarted',
              description: `Session ${result.session.id.slice(0, 8)} started.`,
            });
          }
          clearPendingRestart(restartKeyForWorktree(group.apiBase, agentId));
          await refreshWorktreeAgentGroups();
        },
        onError: (error) => {
          if (isMcpNotConfigured(error)) {
            showWorktreeMcpToast(getMcpProviderDetails(error).providerName);
            return;
          }
          toast({
            title: 'Failed to restart session',
            description:
              error instanceof Error ? error.message : 'Unable to restart session right now.',
            variant: 'destructive',
          });
        },
      });
    },
    [
      clearPendingRestart,
      getWorktreeAgentKey,
      pending,
      refreshWorktreeAgentGroups,
      showWorktreeMcpToast,
      toast,
    ],
  );

  const handleTerminateWorktreeSession = useCallback(
    async (group: WorktreeAgentGroup, agentId: string, sessionId: string) => {
      const agentKey = getWorktreeAgentKey(group.name, agentId);
      await runTrackedOperation(pending, agentKey, 'terminating', {
        run: async () => {
          await terminateSession(sessionId, group.apiBase);
          clearPendingRestart(restartKeyForWorktree(group.apiBase, agentId));
          toast({
            title: 'Session terminated',
            description: 'The worktree session was terminated.',
          });
          await refreshWorktreeAgentGroups();
        },
        onError: (error) => {
          toast({
            title: 'Failed to terminate session',
            description:
              error instanceof Error ? error.message : 'Unable to terminate session right now.',
            variant: 'destructive',
          });
        },
      });
    },
    [clearPendingRestart, getWorktreeAgentKey, pending, refreshWorktreeAgentGroups, toast],
  );

  return {
    worktreeSessionActionsByAgentKey: pending.actions,
    getWorktreeAgentKey,
    handleLaunchWorktreeSession,
    handleRestartWorktreeSession,
    handleTerminateWorktreeSession,
  };
}

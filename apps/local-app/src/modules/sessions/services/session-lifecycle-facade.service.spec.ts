import { SessionLifecycleFacade } from './session-lifecycle-facade.service';
import { ConflictError } from '../../../common/errors/error-types';
import type { SessionRuntime } from './session-runtime';
import type { SessionsService } from './sessions.service';
import { createProjectWriteAdmissionStub } from '../../remotes/admission/testing/project-write-admission.stub';

function build() {
  const sessionRuntime = {
    launch: jest.fn().mockResolvedValue({ id: 'new-session' }),
    restore: jest.fn().mockResolvedValue({ id: 'restored-session' }),
  } as unknown as jest.Mocked<Pick<SessionRuntime, 'launch' | 'restore'>>;
  const sessionsService = {
    listActiveSessions: jest.fn().mockResolvedValue([]),
    terminateSession: jest.fn().mockResolvedValue(undefined),
    getAgentSessionHistory: jest.fn().mockResolvedValue({
      items: [],
      nextCursor: null,
      hasMore: false,
      total: 0,
    }),
    validateSessionInProject: jest.fn(),
    hardDeleteRecord: jest.fn().mockReturnValue({ deleted: true }),
    updateName: jest.fn().mockReturnValue({ id: 's1', name: 'New name' }),
  } as unknown as jest.Mocked<
    Pick<
      SessionsService,
      | 'listActiveSessions'
      | 'terminateSession'
      | 'getAgentSessionHistory'
      | 'validateSessionInProject'
      | 'hardDeleteRecord'
      | 'updateName'
    >
  >;
  const facade = new SessionLifecycleFacade(
    sessionRuntime as unknown as SessionRuntime,
    sessionsService as unknown as SessionsService,
    createProjectWriteAdmissionStub() as never,
  );
  return { facade, sessionRuntime, sessionsService };
}

describe('SessionLifecycleFacade', () => {
  it('launch delegates to SessionRuntime.launch', async () => {
    const { facade, sessionRuntime } = build();
    const result = await facade.launch('a1', 'p1');
    expect(sessionRuntime.launch).toHaveBeenCalledWith({ agentId: 'a1', projectId: 'p1' });
    expect(result).toEqual({ id: 'new-session' });
  });

  it('restore delegates to SessionRuntime.restore', async () => {
    const { facade, sessionRuntime } = build();
    await facade.restore('s1', 'p1');
    expect(sessionRuntime.restore).toHaveBeenCalledWith('s1', 'p1');
  });

  it('terminate delegates to SessionsService.terminateSession', async () => {
    const { facade, sessionsService } = build();
    await facade.terminate('s1');
    expect(sessionsService.terminateSession).toHaveBeenCalledWith('s1', {
      source: 'mobile-rpc',
      reason: 'user-requested',
    });
  });

  describe('restart (sequential terminate + launch)', () => {
    it('terminates the agent existing session then launches a new one', async () => {
      const { facade, sessionRuntime, sessionsService } = build();
      (sessionsService.listActiveSessions as jest.Mock).mockResolvedValue([
        { id: 'old-session', agentId: 'a1' },
        { id: 'other', agentId: 'a2' },
      ]);

      const result = await facade.restart('a1', 'p1');

      expect(sessionsService.terminateSession).toHaveBeenCalledWith('old-session', {
        source: 'mobile-rpc',
        reason: 'restart',
      });
      expect(sessionRuntime.launch).toHaveBeenCalledWith({ agentId: 'a1', projectId: 'p1' });
      expect(result).toEqual({ id: 'new-session' });
    });

    it('launches even when no existing session is found', async () => {
      const { facade, sessionRuntime, sessionsService } = build();
      await facade.restart('a1', 'p1');
      expect(sessionsService.terminateSession).not.toHaveBeenCalled();
      expect(sessionRuntime.launch).toHaveBeenCalledWith({ agentId: 'a1', projectId: 'p1' });
    });

    it('still launches when terminating the existing session fails (best-effort)', async () => {
      const { facade, sessionRuntime, sessionsService } = build();
      (sessionsService.listActiveSessions as jest.Mock).mockResolvedValue([
        { id: 'old-session', agentId: 'a1' },
      ]);
      (sessionsService.terminateSession as jest.Mock).mockRejectedValue(new Error('tmux gone'));

      const result = await facade.restart('a1', 'p1');

      expect(sessionRuntime.launch).toHaveBeenCalledWith({ agentId: 'a1', projectId: 'p1' });
      expect(result).toEqual({ id: 'new-session' });
    });
  });

  describe('listAgentHistory', () => {
    it('delegates to SessionsService.getAgentSessionHistory with cursor + limit', async () => {
      const { facade, sessionsService } = build();
      const result = await facade.listAgentHistory('a1', 'p1', 'CURSOR', 50);
      expect(sessionsService.getAgentSessionHistory).toHaveBeenCalledWith('a1', 'p1', 'CURSOR', 50);
      expect(result).toEqual({ items: [], nextCursor: null, hasMore: false, total: 0 });
    });
  });

  describe('deleteSessionRecord', () => {
    it('runs the shared guard then deletes a non-running session record', async () => {
      const { facade, sessionsService } = build();
      (sessionsService.validateSessionInProject as jest.Mock).mockResolvedValue({
        id: 's1',
        status: 'stopped',
      });

      const result = await facade.deleteSessionRecord('s1', 'p1');

      expect(sessionsService.validateSessionInProject).toHaveBeenCalledWith('s1', 'p1');
      expect(sessionsService.hardDeleteRecord).toHaveBeenCalledWith('s1');
      expect(result).toEqual({ deleted: true });
    });

    it('throws ConflictError (STATUS_RUNNING) and does NOT delete a running session', async () => {
      const { facade, sessionsService } = build();
      (sessionsService.validateSessionInProject as jest.Mock).mockResolvedValue({
        id: 's1',
        status: 'running',
      });

      await expect(facade.deleteSessionRecord('s1', 'p1')).rejects.toMatchObject({
        code: 'conflict',
        details: { code: 'STATUS_RUNNING' },
      });
      await expect(facade.deleteSessionRecord('s1', 'p1')).rejects.toBeInstanceOf(ConflictError);
      expect(sessionsService.hardDeleteRecord).not.toHaveBeenCalled();
    });

    it('propagates the guard error (e.g. cross-project) without deleting', async () => {
      const { facade, sessionsService } = build();
      (sessionsService.validateSessionInProject as jest.Mock).mockRejectedValue(
        new Error('forbidden'),
      );

      await expect(facade.deleteSessionRecord('s1', 'p1')).rejects.toThrow('forbidden');
      expect(sessionsService.hardDeleteRecord).not.toHaveBeenCalled();
    });
  });

  describe('renameSession', () => {
    it('runs the shared guard then delegates to updateName (preserving null)', async () => {
      const { facade, sessionsService } = build();
      (sessionsService.validateSessionInProject as jest.Mock).mockResolvedValue({ id: 's1' });

      const result = await facade.renameSession('s1', 'p1', null);

      expect(sessionsService.validateSessionInProject).toHaveBeenCalledWith('s1', 'p1');
      expect(sessionsService.updateName).toHaveBeenCalledWith('s1', null);
      expect(result).toEqual({ id: 's1', name: 'New name' });
    });

    it('propagates the guard error without renaming', async () => {
      const { facade, sessionsService } = build();
      (sessionsService.validateSessionInProject as jest.Mock).mockRejectedValue(
        new Error('not found'),
      );

      await expect(facade.renameSession('s1', 'p1', 'X')).rejects.toThrow('not found');
      expect(sessionsService.updateName).not.toHaveBeenCalled();
    });
  });
});
